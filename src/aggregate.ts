/**
 * Per-provider aggregation (TWO-679 v2).
 *
 * Pure functions over the sync cache: per provider (and per requested model
 * where CLIProxy reports per-model state), fold the discovered account rows
 * into a single `allowed | exhausted | unknown` verdict.
 *
 * - `allowed` while at least one enabled account has positive evidence of
 *   headroom: a fresh quota reading under the reserve threshold, or a fresh
 *   plugin-route reading.
 * - `exhausted` only when every enabled account is positively out (quota
 *   exhausted, or cooling with a future `next_retry_after`) **and**
 *   `completeInventory` is true. `retryAt` is the earliest per-account
 *   recovery bound across those accounts, where one account's bound is the
 *   latest required reset among its own limiting windows (an account with
 *   both 5h and 7d exhausted recovers only when the later clears) — unless a
 *   limiting condition has no usable reset, in which case that account
 *   rechecks at the recheck cadence instead of sleeping past a distant reset.
 * - `unknown` otherwise, including stale data and zero visible accounts.
 *   Never claims headroom.
 * - Paid credits (TWO-2107, opt-in per provider row via
 *   `creditsCountAsHeadroom`): a positive credits reading covers the
 *   account's limiting quota windows, because the upstream keeps serving
 *   from the balance. A fresh reading is headroom; a stale one is `unknown`
 *   (fail open, never wait on a window the balance pays past). Credits never
 *   cover a 429 cooldown, a `retry-after` watermark or an unavailable
 *   account, and `has-credits: false` or a non-positive balance covers
 *   nothing.
 *
 * Two ages (inherited from the v1 router): cache age (row `checkedAt`, the
 * sync fetch time) tells whether sync is alive — an expired cache is
 * `unknown`, never a verdict. Observation age (per window `observedAt`)
 * tells whether a window's reading is still evidence: a *limiting* verdict
 * with a future reset stays limiting whatever the observation age (usage
 * cannot drop before its reset); anything else that is stale becomes
 * `unknown`.
 */

import { effectiveReservePercent, graceMs, maxAgeMs, type ConnectorConfig } from "./config.js";
import { hasAdmissionSignal, namespaceMatchesProvider, normalizeProvider } from "./parsers.js";
import type { AccountUsageRow, CreditsReading, Freshness, ProviderState, UsageLimitRow } from "./types.js";

export interface ProviderAssessment {
  provider: string;
  /** Requested model (lowercased) the verdict was computed for, or null. */
  model: string | null;
  state: ProviderState;
  /** Earliest reset/cooldown end behind an `exhausted` verdict, else null. */
  retryAt: string | null;
  /** Cache freshness of the underlying rows. */
  freshness: Freshness;
  /** True when `completeInventory` is false and wait/resume is off. */
  waitResumeOff: boolean;
  enabledAccounts: number;
  headroomAccounts: number;
  /** Headroom accounts whose headroom comes from paid credits (TWO-2107). */
  creditHeadroomAccounts: number;
  /** Human reason; always non-empty. */
  reason: string;
}

function parseTime(v: string | null | undefined): number | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function classifyFreshness(
  checkedAt: string | null,
  nowMs: number,
  maxAge: number,
  grace: number,
  futureSkewMs: number,
): { freshness: Freshness; ageMs: number | null } {
  if (!checkedAt) return { freshness: "missing", ageMs: null };
  const at = parseTime(checkedAt);
  if (at === null) return { freshness: "missing", ageMs: null };
  if (at > nowMs + futureSkewMs) return { freshness: "missing", ageMs: null };
  const age = nowMs - Math.min(at, nowMs);
  if (age <= maxAge) return { freshness: "fresh", ageMs: age };
  if (age <= grace) return { freshness: "stale", ageMs: age };
  return { freshness: "expired", ageMs: age };
}

/**
 * Observation age of one window in ms, or null when it cannot be trusted.
 * Falls back to the row's fetch time for rows cached before per-window
 * `observedAt` existed (or hand-built rows without it).
 */
function windowObservationAgeMs(
  observedAt: string | null | undefined,
  rowCheckedAt: string,
  nowMs: number,
  futureSkewMs: number,
): number | null {
  const raw = observedAt ?? rowCheckedAt;
  if (!raw) return null;
  const t = parseTime(raw);
  if (t === null) return null;
  if (t > nowMs + futureSkewMs) return null;
  return nowMs - Math.min(t, nowMs);
}

/**
 * Strip a leading provider namespace (`ns/rest` → `rest`) when — and only
 * when — it names this aggregate's own provider. The mapping is data, not
 * parsing: the namespace equals the provider string, or the explicit
 * `NAMESPACE_TO_PROVIDER` table (`nvidia` → `nvidia-nim`, `cloudflare` →
 * `cloudflare-workers-ai`). `devin/…` and the plugin namespaces strip for
 * their own provider; stock bare ids have nothing to strip. A namespace
 * naming any other provider (or none) stays literal, so a request can never
 * match another provider's per-model window. Matching always tries both the
 * full and the stripped form, so bare and namespaced requests for the same
 * model agree.
 */
export function stripProviderNamespace(model: string, provider: string): string {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return model;
  const ns = model.slice(0, slash);
  const rest = model.slice(slash + 1);
  if (!namespaceMatchesProvider(ns, provider)) return model;
  return rest;
}

function windowAppliesToModel(window: UsageLimitRow, model: string | null, provider: string): boolean {
  const models = window.models;
  if (model === null) {
    // No requested model: only account-level windows (models == null) apply.
    // Per-model windows are evidence about their own model, not about the
    // provider — a provider-level verdict must never be poisoned by one
    // model's exhaustion when the account itself has headroom.
    return !models || models.length === 0;
  }
  if (!models || models.length === 0) return true; // account-level: all models
  // CLIProxy keys `model_quotas` by bare id; the candidate's
  // `runtimeConfig.model` may carry the provider namespace (`devin/…`,
  // plugin namespaces). Compare both forms on both sides.
  const candidates = new Set([model, stripProviderNamespace(model, provider)]);
  return models.some((m) => {
    const key = m.toLowerCase();
    return candidates.has(key) || candidates.has(stripProviderNamespace(key, provider));
  });
}

/**
 * True when a credits reading says the upstream keeps serving from a paid
 * balance: `unlimited`, or `has-credits: true` with a positive (or absent)
 * balance. `has-credits: false` or a non-positive balance is never cover.
 */
export function creditsPositive(credits: CreditsReading | null | undefined): boolean {
  if (!credits) return false;
  if (credits.hasCredits === false) return false;
  if (credits.unlimited === true) return true;
  if (credits.hasCredits !== true) return false;
  return credits.balance === null || credits.balance > 0;
}

/**
 * Windows a positive credits balance can cover: quota windows only. A 429
 * cooldown or a `retry-after` watermark means the upstream refused traffic,
 * credits or not, so those always keep gating.
 */
function creditCoverable(w: UsageLimitRow): boolean {
  return !w.id.endsWith(":retry-after") && !w.id.includes(":quota-cooldown");
}

type AccountVerdict =
  | { kind: "headroom"; viaCredits?: boolean }
  | { kind: "out"; resets: string[] }
  | { kind: "unknown"; reason: string };

function assessAccount(
  row: AccountUsageRow,
  model: string | null,
  nowMs: number,
  reserve: number,
  maxAge: number,
  grace: number,
  futureSkewMs: number,
  creditsCover: boolean,
): AccountVerdict {
  // Cooling with a future recovery time is positively out whatever the
  // windows say; an unavailable account with no future recovery is still
  // positively out (persistent auth/token failure) but bounds no wait.
  if (row.coolingDown) {
    const untilMs = row.cooldownUntil ? parseTime(row.cooldownUntil) : null;
    if (untilMs !== null && untilMs <= nowMs) {
      return { kind: "unknown", reason: "cooldown lifted with no fresh telemetry since; unknown." };
    }
    return {
      kind: "out",
      resets: untilMs !== null && row.cooldownUntil ? [row.cooldownUntil] : [],
    };
  }

  const applicable = row.limits.filter((l) => l.gating && windowAppliesToModel(l, model, row.provider));
  if (applicable.length === 0) {
    return { kind: "unknown", reason: "no gating windows applicable to this model; unknown." };
  }

  const admission = hasAdmissionSignal(normalizeProvider(row.provider));
  const limiting: string[] = [];
  const unknownWindows: string[] = [];
  const covered: string[] = [];
  let headroom = false;
  for (const w of applicable) {
    const resetMs = w.resetsAt ? parseTime(w.resetsAt) : null;
    const verdict: "limiting" | "healthy" | "unknown" = (() => {
      if (w.allowed === false || w.limitReached) return "limiting";
      if (w.allowed === null && admission) return "limiting";
      if (w.remainingPercent !== null) return w.remainingPercent <= reserve ? "limiting" : "healthy";
      if (w.allowed === null && !admission) return "unknown";
      return "unknown";
    })();
    if (verdict === "limiting" && creditsCover && creditCoverable(w)) {
      covered.push(w.id);
      continue;
    }
    if (verdict === "limiting" && resetMs !== null) {
      if (resetMs > nowMs) {
        // Exhausted with a future reset: still true whatever the observation
        // age (usage cannot drop before the reset).
        limiting.push(w.id);
        continue;
      }
      unknownWindows.push(`${w.id} (reset passed)`);
      continue;
    }
    const obsAge = windowObservationAgeMs(w.observedAt, row.checkedAt, nowMs, futureSkewMs);
    const stale = obsAge === null || obsAge > grace;
    if (verdict === "limiting") {
      if (stale) {
        unknownWindows.push(w.id);
        continue;
      }
      limiting.push(w.id);
      continue;
    }
    if (verdict === "unknown") {
      unknownWindows.push(w.id);
      continue;
    }
    // Healthy: only a fresh observation is evidence of headroom. Fresh here
    // means within maxAge (a fresh quota reading under the reserve
    // threshold); a merely grace-stale reading is unknown, never headroom.
    if (obsAge === null || obsAge > maxAge) {
      unknownWindows.push(w.id);
      continue;
    }
    headroom = true;
  }

  if (limiting.length > 0) return { kind: "out", resets: [] };
  if (creditsCover) {
    // The balance pays past every quota window, so a fresh credits reading
    // is headroom whatever the windows say. A stale one decides only when it
    // carries the verdict (some window is covered): unknown, never out —
    // nothing bounds a wait on a balance. With nothing covered the windows
    // decide below, so a stale reading never vetoes fresh window headroom.
    const creditsAge = windowObservationAgeMs(row.credits?.observedAt, row.checkedAt, nowMs, futureSkewMs);
    if (creditsAge !== null && creditsAge <= maxAge) return { kind: "headroom", viaCredits: covered.length > 0 };
    if (covered.length > 0) {
      return { kind: "unknown", reason: "paid credits cover the quota windows but the credits reading is stale; unknown." };
    }
  }
  // Positive headroom requires fresh evidence on EVERY applicable window: a
  // single unknown window (missing or stale telemetry) vetoes headroom, or a
  // healthy 5h reading would mask an exhausted 7d window.
  if (headroom && unknownWindows.length === 0) return { kind: "headroom" };
  if (headroom) return { kind: "unknown", reason: `fresh headroom on some windows but no fresh verdict on ${unknownWindows.join(", ")}; unknown.` };
  return { kind: "unknown", reason: `no fresh verdict on ${unknownWindows.join(", ")}; unknown.` };
}

export function aggregateProvider(args: {
  provider: string;
  /** Requested model (any case), or null when the caller names none. */
  model: string | null;
  rows: AccountUsageRow[];
  completeInventory: boolean;
  /** Provider row opt-in: positive paid credits count as headroom (TWO-2107). */
  creditsCountAsHeadroom?: boolean;
  config: ConnectorConfig;
  now: string;
  poolId?: string;
  poolThresholdPercent?: unknown;
}): ProviderAssessment {
  const { provider, config } = args;
  const model = args.model ? args.model.toLowerCase() : null;
  const nowMs = parseTime(args.now) ?? Date.now();
  const reserve = effectiveReservePercent(config, {
    id: args.poolId,
    thresholdPercent: args.poolThresholdPercent,
  });
  const maxAge = maxAgeMs(config);
  const grace = graceMs(config);
  const futureSkewMs = config.futureSkewSeconds * 1000;

  const enabled = args.rows.filter((r) => r.provider === provider && r.status !== "disabled");
  const waitResumeOff = !args.completeInventory;

  if (enabled.length === 0) {
    return {
      provider,
      model,
      state: "unknown",
      retryAt: null,
      freshness: "missing",
      waitResumeOff,
      enabledAccounts: 0,
      headroomAccounts: 0,
      creditHeadroomAccounts: 0,
      reason: `no enabled ${provider} accounts in the sync cache; unknown (never headroom).`,
    };
  }

  // Cache age: the newest row fetch is the sync's fetch time; the oldest
  // bounds trust. An expired cache is unknown, never a verdict. Row fetch
  // times go through the same future-skew rejection as window observations:
  // a checkedAt beyond the skew is missing, never fresh.
  const infos = enabled.map((r) => classifyFreshness(r.checkedAt, nowMs, maxAge, grace, futureSkewMs));
  if (infos.some((i) => i.freshness === "missing")) {
    return {
      provider,
      model,
      state: "unknown",
      retryAt: null,
      freshness: "missing",
      waitResumeOff,
      enabledAccounts: enabled.length,
      headroomAccounts: 0,
      creditHeadroomAccounts: 0,
      reason: `telemetry for ${provider} has no usable fetch time; unknown.`,
    };
  }
  const oldest = Math.max(...infos.map((i) => i.ageMs as number));
  const freshness: Freshness = oldest <= maxAge ? "fresh" : oldest <= grace ? "stale" : "expired";
  if (freshness === "expired") {
    return {
      provider,
      model,
      state: "unknown",
      retryAt: null,
      freshness,
      waitResumeOff,
      enabledAccounts: enabled.length,
      headroomAccounts: 0,
      creditHeadroomAccounts: 0,
      reason: `telemetry for ${provider} is beyond the grace window; unknown (never headroom).`,
    };
  }

  let headroomAccounts = 0;
  let creditHeadroomAccounts = 0;
  // Per-account recovery bounds: an account recovers only when ALL of its
  // limiting windows clear, so its bound is the LATEST required reset (not the
  // earliest). The provider wakes when the FIRST account may have recovered,
  // so the aggregate retry is the earliest per-account bound.
  const perAccountBounds: number[] = [];
  let allOut = true;
  for (const row of enabled) {
    const creditsCover = args.creditsCountAsHeadroom === true && creditsPositive(row.credits);
    const verdict = assessAccount(row, model, nowMs, reserve, maxAge, grace, futureSkewMs, creditsCover);
    if (verdict.kind === "headroom") {
      headroomAccounts += 1;
      if (verdict.viaCredits) creditHeadroomAccounts += 1;
      allOut = false;
    } else if (verdict.kind === "out") {
      const bounds: number[] = [];
      // A limiting condition with no usable future reset (missing resetsAt,
      // a passed reset the parser kept, an unbounded cooldown) may clear at
      // any time: cap this account's next check at the recheck cadence even
      // when another window carries a distant reset.
      let hasUnboundedLimiting = false;
      for (const w of row.limits) {
        if (!w.gating || !windowAppliesToModel(w, model, provider)) continue;
        // Covered windows never bound the wait: only the uncovered ones
        // (429 cooldown, retry-after) put this account out.
        if (creditsCover && creditCoverable(w)) continue;
        const resetMs = w.resetsAt ? parseTime(w.resetsAt) : null;
        // Any limiting signal counts, including low-remaining windows whose
        // `allowed` is still true: the account cannot route until they clear.
        const limiting =
          w.allowed === false || w.limitReached || (w.remainingPercent !== null && w.remainingPercent <= reserve);
        if (!limiting) continue;
        if (resetMs !== null && resetMs > nowMs) bounds.push(resetMs);
        else hasUnboundedLimiting = true;
      }
      if (row.coolingDown) {
        const untilMs = row.cooldownUntil ? parseTime(row.cooldownUntil) : null;
        if (untilMs !== null && untilMs > nowMs) bounds.push(untilMs);
        else hasUnboundedLimiting = true;
      }
      const recheckAt = nowMs + config.recheckSeconds * 1000;
      // Unbounded limiting may clear at any time, so recheck at the cadence
      // even when a sibling window carries a distant reset. Fully bounded
      // accounts keep the latest reset: nothing can change before it.
      // An out account with no future bound still re-wakes at the recheck
      // cadence so exhaustion never waits forever on a missing reset.
      perAccountBounds.push(
        hasUnboundedLimiting ? recheckAt : bounds.length > 0 ? Math.max(...bounds) : recheckAt,
      );
    } else {
      allOut = false;
    }
  }

  if (headroomAccounts > 0) {
    return {
      provider,
      model,
      state: "allowed",
      retryAt: null,
      freshness,
      waitResumeOff,
      enabledAccounts: enabled.length,
      headroomAccounts,
      creditHeadroomAccounts,
      reason: `${headroomAccounts}/${enabled.length} enabled ${provider} account(s) show fresh headroom${model ? ` for model ${model}` : ""}${creditHeadroomAccounts > 0 ? ` (${creditHeadroomAccounts} on paid credits past exhausted quota windows)` : ""}.`,
    };
  }
  if (allOut && args.completeInventory) {
    const future = perAccountBounds.filter((t) => t > nowMs);
    let retryAt =
      future.length > 0
        ? new Date(Math.min(...future)).toISOString()
        : new Date(nowMs + config.recheckSeconds * 1000).toISOString();
    if (retryAt <= new Date(nowMs + 1000).toISOString()) {
      retryAt = new Date(nowMs + 1000).toISOString();
    }
    return {
      provider,
      model,
      state: "exhausted",
      retryAt,
      freshness,
      waitResumeOff: false,
      enabledAccounts: enabled.length,
      headroomAccounts: 0,
      creditHeadroomAccounts: 0,
      reason: `every enabled ${provider} account is positively out${model ? ` for model ${model}` : ""}; retry at ${retryAt}.`,
    };
  }
  return {
    provider,
    model,
    state: "unknown",
    retryAt: null,
    freshness,
    waitResumeOff,
    enabledAccounts: enabled.length,
    headroomAccounts: 0,
    creditHeadroomAccounts: 0,
    reason: allOut
      ? `every enabled ${provider} account is out, but inventory is not confirmed complete; unknown (wait/resume off).`
      : `no enabled ${provider} account shows fresh headroom${model ? ` for model ${model}` : ""}; unknown.`,
  };
}
