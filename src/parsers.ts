/**
 * Per-provider quota parsers (TWO-578 spike matrix §2 + §3.3 + §6, TWO-679 v2).
 *
 * Every parser normalizes into `UsageLimitRow[]` with the same field names as
 * `shared/ai-connection-usage.d.ts`, so the later core hook is a format no-op.
 * The iron rule: missing provider data is `unknown`, never headroom. A parser
 * that cannot understand a payload returns zero gating windows (quota-blind)
 * instead of guessing.
 *
 * Two payload shapes are consumed (proposal §4 GET allow-list):
 * 1. `auth-files` entries: reconciled per-credential state (`disabled`,
 *    `unavailable`, `next_retry_after`, `status`, `status_message`,
 *    `priority`) plus passive quota observations for Claude, Codex and Devin
 *    (`quota{observed_at, signals}`, `model_quotas` keyed by model). Signal
 *    maps carry raw upstream header names to string values
 *    (`anthropic-ratelimit-unified-*-utilization`, `x-codex-*-used-percent`,
 *    `retry-after`, …) — see `quota_signals.go` in CLIProxyAPI. Exact live
 *    management JSON is still operator-captured when available; until then
 *    the fixture in `sync.test.ts` mirrors the source shapes above.
 * 2. Plugin quota routes: the normalized `QuotaFetchResponse` shape
 *    (`Subscription`, `Summary`, `Groups[].Buckets[]` with `Window`,
 *    `RemainingFraction`, `ResetTime`) our five provider plugins return.
 */

import { createHash } from "node:crypto";
import type { AccountStatus, UsageLimitRow } from "./types.js";

/* ------------------------------------------------------------------ */
/* small defensive accessors                                           */
/* ------------------------------------------------------------------ */

type Json = Record<string, unknown>;

function asObj(v: unknown): Json | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null;
}

function getStr(o: Json, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

function getNum(o: Json, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

function getObj(o: Json, ...keys: string[]): Json | null {
  for (const k of keys) {
    const v = asObj(o[k]);
    if (v) return v;
  }
  return null;
}

/**
 * Coerce epoch seconds / epoch millis / ISO string / Date into ISO.
 * Returns null when the value is absent or unparseable. Numbers that are
 * implausibly far in the past/future are rejected.
 */
export function toIsoTimestamp(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  let ms: number | null = null;
  if (v instanceof Date) {
    ms = v.getTime();
  } else if (typeof v === "number" && Number.isFinite(v)) {
    if (v > 1e14) ms = v; // micros+ — treat as ms anyway, validation below rejects
    else if (v >= 1e12) ms = v; // epoch millis
    else if (v >= 1e9) ms = v * 1000; // epoch seconds
    else return null;
  } else if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    if (/^-?\d+(\.\d+)?$/.test(s)) return toIsoTimestamp(Number(s));
    const t = Date.parse(s);
    if (Number.isNaN(t)) return null;
    ms = t;
  } else {
    return null;
  }
  if (ms === null || !Number.isFinite(ms)) return null;
  if (ms < Date.parse("2020-01-01T00:00:00Z") || ms > Date.parse("2100-01-01T00:00:00Z")) return null;
  return new Date(ms).toISOString();
}

/** Opaque sha256 of an upstream account identity. Null when there is nothing to hash. */
export function hashIdentity(parts: Array<string | null | undefined>): string | null {
  const joined = parts
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .join("\u0000");
  if (!joined) return null;
  return createHash("sha256").update(joined, "utf8").digest("hex");
}

/* ------------------------------------------------------------------ */
/* provider normalization                                              */
/* ------------------------------------------------------------------ */

export type ProviderKey =
  | "claude"
  | "codex"
  | "devin"
  | "meta"
  | "antigravity"
  | "xai"
  | "kimi"
  | "compat"
  | "synthetic"
  | "nvidia-nim"
  | "cloudflare"
  | "zai"
  | "opencode-go"
  | "unknown-provider";

/**
 * Map a CLIProxy provider word into a parser key. This chooses ONLY the quota
 * parser and the admission-signal class (unknown words fall back to the
 * generic parser, which understands no signal shape and stays quota-blind).
 * It is never an identity: grouping, config, drift and routing all use the
 * raw auth-file provider string (trimmed, lowercased).
 */
export function normalizeProvider(channel: unknown): ProviderKey {
  const c = String(channel ?? "").toLowerCase().replace(/[_-]/g, "-");
  if (!c) return "unknown-provider";
  if (c.includes("claude") || c === "anthropic") return "claude";
  if (c.includes("codex") || c === "openai") return "codex";
  if (c.includes("devin") || c.includes("cognition")) return "devin";
  if (c.includes("meta")) return "meta";
  if (c.includes("antigravity") || c.includes("gemini")) return "antigravity";
  if (c.includes("xai") || c.includes("grok")) return "xai";
  if (c.includes("kimi") || c.includes("moonshot")) return "kimi";
  if (c.includes("opencode-go") || c.includes("opencodego")) return "opencode-go";
  if (c.includes("opencode") || c.includes("compat") || c.includes("zen")) return "compat";
  if (c.includes("synthetic")) return "synthetic";
  // Token match on `nim`, not substring: a bare `includes("nim")` misfiles a
  // provider such as `minimax` as `nvidia-nim`.
  if (c.includes("nvidia") || /(^|-)nim($|-)/.test(c)) return "nvidia-nim";
  if (c.includes("cloudflare")) return "cloudflare";
  if (c === "zai" || c.includes("zai") || c.includes("glm") || c.includes("zhipu")) return "zai";
  return "unknown-provider";
}

/**
 * Namespaces that differ from their provider string (spike TWO-681 §1: the
 * table is data, not parsing). Every other namespace equals its provider
 * string, so future providers (e.g. `openrouter/…`) resolve with no code
 * change. Used by model → provider derivation and namespace stripping —
 * never by quota grouping.
 */
export const NAMESPACE_TO_PROVIDER: Record<string, string> = {
  nvidia: "nvidia-nim",
  cloudflare: "cloudflare-workers-ai",
};

/** True when `ns` names `provider`: exact match or the explicit table above. */
export function namespaceMatchesProvider(namespace: string, provider: string): boolean {
  const ns = namespace.toLowerCase();
  const p = provider.toLowerCase();
  if (ns === p) return true;
  return NAMESPACE_TO_PROVIDER[ns] === p;
}

/** Providers whose quota observations carry an admission signal. */
export function hasAdmissionSignal(provider: ProviderKey): boolean {
  switch (provider) {
    case "claude":
    case "codex":
    case "devin":
    case "synthetic":
    case "cloudflare":
    case "zai":
    case "opencode-go":
      return true;
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ */
/* window gating                                                       */
/* ------------------------------------------------------------------ */

/**
 * Decide whether a window gates routing. Rules (TWO-579):
 * - feature-scoped windows (`scope !== null`) are ignored, never gating;
 * - spend-control blocks always gate (and exhaust);
 * - otherwise the window id must match the provider allow-list substring.
 */
export function isGatingWindow(
  provider: ProviderKey,
  windowId: string,
  allowList: string[],
  opts?: { scope?: unknown; spendControl?: boolean },
): boolean {
  if (opts?.spendControl) return true;
  if (opts?.scope !== undefined && opts?.scope !== null) return false;
  const id = windowId.toLowerCase();
  return allowList.some((sub) => sub !== "" && id.toLowerCase().includes(sub.toLowerCase()));
}

function makeLimit(init: {
  id: string;
  label: string;
  usedPercent?: number | null;
  remainingPercent?: number | null;
  resetsAt?: string | null;
  limitReached?: boolean;
  allowed?: boolean | null;
  gating?: boolean;
  observedAt?: string | null;
  models?: string[] | null;
}): UsageLimitRow {
  return {
    id: init.id,
    label: init.label,
    usedPercent: init.usedPercent ?? null,
    remainingPercent: init.remainingPercent ?? null,
    resetsAt: init.resetsAt ?? null,
    limitReached: init.limitReached ?? false,
    allowed: init.allowed ?? null,
    gating: init.gating ?? false,
    observedAt: init.observedAt ?? null,
    models: init.models ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* plugin normalized quota shape                                       */
/* ------------------------------------------------------------------ */

export interface ParsedPluginQuota {
  planType: string | null;
  limits: UsageLimitRow[];
  warnings: string[];
}

/**
 * Parse the normalized `QuotaFetchResponse` our provider plugins return
 * (`Subscription{Plan,TierName,TierID}`, `Summary[]`, `Groups[].Buckets[]`
 * with `Window`, `RemainingFraction`, `ResetTime`, `Description`).
 *
 * Mapping: `usedPercent = (1 − RemainingFraction) × 100`,
 * `resetsAt = ResetTime`, `allowed = RemainingFraction > 0`.
 * Per-window tolerance (G-G2 lesson): one malformed bucket never blinds the
 * rest — it is skipped with a warning.
 */
export function parsePluginQuota(
  provider: ProviderKey,
  payload: unknown,
  allowList: string[],
  opts?: { softGating?: boolean; observedAt?: string | null },
): ParsedPluginQuota {
  const warnings: string[] = [];
  const limits: UsageLimitRow[] = [];
  const root = asObj(payload);
  if (!root) {
    warnings.push(`${provider}: plugin quota payload is not an object; treating as unknown.`);
    return { planType: null, limits, warnings };
  }

  const sub = getObj(root, "Subscription", "subscription");
  const planType =
    getStr(sub ?? {}, "Plan", "plan", "TierName", "tierName", "PlanName", "planName") ?? null;

  const groups = Array.isArray(root.Groups)
    ? root.Groups
    : Array.isArray(root.groups)
      ? root.groups
      : null;
  if (!groups) {
    warnings.push(`${provider}: plugin quota payload has no Groups; treating as unknown.`);
    return { planType, limits, warnings };
  }

  for (const g of groups) {
    const group = asObj(g);
    if (!group) {
      warnings.push(`${provider}: skipping a malformed quota group.`);
      continue;
    }
    const buckets = Array.isArray(group.Buckets) ? group.Buckets : [];
    for (const b of buckets) {
      const bucket = asObj(b);
      if (!bucket) {
        warnings.push(`${provider}: skipping a malformed quota bucket.`);
        continue;
      }
      const windowName =
        getStr(bucket, "Window", "window", "Name", "name", "id", "Id") ?? "window";
      const remaining =
        getNum(bucket, "RemainingFraction", "remainingFraction", "remaining", "Remaining", "percent") ??
        null;
      // Some shapes report percent-consumed instead of percent-remaining.
      const consumed =
        getNum(bucket, "UsedPercent", "usedPercent", "used", "Used", "consumed") ?? null;
      const resetsAt = toIsoTimestamp(
        bucket.ResetTime ?? bucket.resetTime ?? bucket.resetsAt ?? bucket.ResetsAt ?? null,
      );
      const description = getStr(bucket, "Description", "description");
      const scope = bucket.Scope ?? bucket.scope ?? null;

      let usedPercent: number | null = null;
      let remainingPercent: number | null = null;
      if (remaining !== null && remaining >= 0 && remaining <= 1.5) {
        // `percent` aliases: opencode-go reports 0-100 percent remaining.
        const frac = remaining > 1 ? remaining / 100 : remaining;
        remainingPercent = Math.max(0, Math.min(100, frac * 100));
        usedPercent = 100 - remainingPercent;
      } else if (consumed !== null && consumed >= 0 && consumed <= 150) {
        usedPercent = Math.min(150, consumed);
        remainingPercent = Math.max(0, 100 - Math.min(100, consumed));
      }
      if (usedPercent === null && remainingPercent === null) {
        warnings.push(`${provider}: bucket ${JSON.stringify(windowName)} has no usable percent; skipping.`);
        continue;
      }

      const exhausted = (remainingPercent ?? 100) <= 0;
      const gating =
        opts?.softGating === true
          ? false
          : isGatingWindow(provider, windowName, allowList, { scope });
      limits.push(
        makeLimit({
          id: `${provider}:${windowName}`,
          label: description ?? `${provider} ${windowName}`,
          usedPercent,
          remainingPercent,
          resetsAt,
          limitReached: exhausted,
          allowed: exhausted ? false : true,
          gating,
          // Fetched at sync time: its observation is as fresh as the cache row.
          observedAt: opts?.observedAt ?? null,
        }),
      );
    }
  }
  return { planType, limits, warnings };
}

/* ------------------------------------------------------------------ */
/* passive official-provider signals (auth-files observations)         */
/* ------------------------------------------------------------------ */

export interface ParsedSignals {
  limits: UsageLimitRow[];
  /** `observed_at` coerced to ISO, or null when absent/unparseable. */
  observedAt: string | null;
  /** Plan label carried by the signals (Codex `x-codex-plan-type`), if any. */
  planType: string | null;
  warnings: string[];
}

interface WindowAccum {
  window: string;
  used: number | null;
  allowed: boolean | null;
  limitReached: boolean;
  resetsAt: string | null;
  extraResetMs: number[];
  labelExtra: string | null;
  spendBlocked: boolean;
}

function newWindowAccum(window: string): WindowAccum {
  return {
    window,
    used: null,
    allowed: null,
    limitReached: false,
    resetsAt: null,
    extraResetMs: [],
    labelExtra: null,
    spendBlocked: false,
  };
}

/** Utilization-like value → used percent. Fractions (0–1.x) scale to 0–100. */
function toUsedPercent(v: number): number | null {
  if (!Number.isFinite(v) || v < 0) return null;
  if (v <= 1.5) return v * 100;
  if (v <= 150) return v;
  return null;
}

/**
 * Parse one passive quota observation (`{observed_at, signals}`) where
 * `signals` is the raw upstream header map CLIProxy snapshots
 * (`sdk/cliproxy/auth/quota_signals.go`): keys are header names, values are
 * strings. Unknown keys are ignored with a single summary warning — never
 * headroom.
 *
 * Claude windows come from `anthropic-ratelimit-unified-<window>-<metric>`
 * (`utilization` fraction, `reset` timestamp, `status` allowed/rejected).
 * Codex windows come from `x-codex-[<ns>-]<primary|secondary>-<metric>`
 * (`used-percent` 0–100, `reset-at` unix, `reset-after-seconds`,
 * `allowed`, `limit-reached`). A bare `retry-after` (seconds) is an explicit
 * 429 watermark for any provider and always limits.
 */
export function parseHeaderSignals(
  provider: ProviderKey,
  signals: Record<string, unknown>,
  observedAt: string | null,
  allowList: string[],
  opts?: { models?: string[] | null; labelPrefix?: string },
): ParsedSignals {
  const warnings: string[] = [];
  const byWindow = new Map<string, WindowAccum>();
  const acc = (window: string): WindowAccum => {
    let a = byWindow.get(window);
    if (!a) {
      a = newWindowAccum(window);
      byWindow.set(window, a);
    }
    return a;
  };
  let ignored = 0;
  let retryAfterSeconds: number | null = null;
  let planType: string | null = null;

  for (const [rawKey, rawValue] of Object.entries(signals)) {
    const key = rawKey.toLowerCase().replace(/_/g, "-");
    const value = typeof rawValue === "string" ? rawValue.trim() : String(rawValue ?? "").trim();
    if (!value) {
      ignored += 1;
      continue;
    }
    if (key === "retry-after") {
      const secs = Number(value);
      if (Number.isFinite(secs) && secs >= 0 && secs < 31_536_000) retryAfterSeconds = secs;
      else ignored += 1;
      continue;
    }
    if (provider === "codex" && (key === "x-codex-plan-type" || key === "x-codex-active-limit")) {
      if (key === "x-codex-plan-type") planType = value;
      continue;
    }
    if (provider === "codex" && key === "x-codex-credits-has-credits") {
      if (value.toLowerCase() === "false") acc("credits").limitReached = true;
      continue;
    }
    if (provider === "codex" && key === "x-codex-credits-balance") continue; // informational only
    if (provider === "codex" && key.endsWith("-limit-name")) {
      // The tier is part of the window identity, exactly as in the metric
      // branch below: a bare `secondary` limit-name belongs to `secondary`
      // (never the primary default), and a namespaced one belongs to
      // `<ns>-<tier>` (never a phantom `<ns>` window).
      const m = /^x-codex-(?:(.*?)-)?(primary|secondary)-limit-name$/.exec(key);
      if (m) acc(m[1] ? `${m[1]}-${m[2]}` : m[2]).labelExtra = value;
      continue;
    }

    // Claude unified: anthropic-ratelimit-unified-<window>-<metric>. Devin
    // serves Claude-family models through the same upstream, so Devin
    // accounts report the same shapes (grouped by auth-file provider).
    let m = /^anthropic-ratelimit-unified-(.+?)-(utilization|reset|status)$/.exec(key);
    if (m && (provider === "claude" || provider === "devin" || provider === "unknown-provider")) {
      const a = acc(m[1]);
      if (m[2] === "utilization") {
        const used = toUsedPercent(Number(value));
        if (used !== null) a.used = Math.max(a.used ?? -Infinity, used);
        else ignored += 1;
      } else if (m[2] === "reset") {
        const iso = toIsoTimestamp(value);
        if (iso) a.extraResetMs.push(Date.parse(iso));
        else ignored += 1;
      } else {
        const v = value.toLowerCase();
        if (v === "allowed") a.allowed = a.allowed === false ? false : true;
        else if (v === "rejected") a.allowed = false;
        else ignored += 1;
      }
      continue;
    }
    // Codex namespaced: x-codex-[<ns>-]<primary|secondary>-<metric>.
    // The namespace and its separator are one optional unit, so the stock
    // unnamespaced `x-codex-primary-*` headers parse too (never silently
    // quota-blind).
    m = /^x-codex-(?:(.*?)-)?(primary|secondary)-(used-percent|window-minutes|reset-at|reset-after-seconds|allowed|limit-reached|over-secondary-limit-percent)$/.exec(key);
    if (m && (provider === "codex" || provider === "unknown-provider")) {
      const window = m[1] ? `${m[1]}-${m[2]}` : m[2];
      const a = acc(window);
      const metric = m[3];
      if (metric === "used-percent") {
        // Codex `used-percent` is already 0–100 (unlike Claude's fractional
        // utilization): a nearly-unused account reads "1", never 100.
        const direct = Number(value);
        const used =
          Number.isFinite(direct) && direct >= 0 && direct <= 150 ? direct : null;
        if (used !== null) a.used = Math.max(a.used ?? -Infinity, used);
        else ignored += 1;
      } else if (metric === "reset-at") {
        const iso = toIsoTimestamp(Number(value));
        if (iso) a.extraResetMs.push(Date.parse(iso));
        else ignored += 1;
      } else if (metric === "reset-after-seconds") {
        const secs = Number(value);
        if (Number.isFinite(secs) && secs >= 0 && secs < 31_536_000) {
          const base = observedAt ? Date.parse(observedAt) : NaN;
          a.extraResetMs.push((Number.isNaN(base) ? Date.now() : base) + secs * 1000);
        } else ignored += 1;
      } else if (metric === "allowed") {
        const v = value.toLowerCase();
        if (v === "true") a.allowed = a.allowed === false ? false : true;
        else if (v === "false") a.allowed = false;
        else ignored += 1;
      } else if (metric === "limit-reached") {
        const v = value.toLowerCase();
        if (v === "true") a.limitReached = true;
        else if (v !== "false") ignored += 1;
      } else {
        // window-minutes / over-secondary-limit-percent: window length metadata.
        ignored += 1;
      }
      continue;
    }
    ignored += 1;
  }

  const limits: UsageLimitRow[] = [];
  for (const a of byWindow.values()) {
    // Metadata alone is never a window: a bare limit-name with no quota
    // reading must not emit an allowed:null row, which reads as limiting
    // for admission-signal providers and would false-exhaust the account.
    if (a.used === null && a.allowed === null && !a.limitReached && a.extraResetMs.length === 0) {
      continue;
    }
    let usedPercent: number | null = a.used;
    let remainingPercent: number | null =
      usedPercent !== null ? Math.max(0, 100 - Math.min(100, usedPercent)) : null;
    const exhausted = a.limitReached || a.allowed === false || (remainingPercent ?? 100) <= 0;
    const resets = a.extraResetMs.filter((t) => Number.isFinite(t));
    const resetsAt = resets.length > 0 ? new Date(Math.max(...resets)).toISOString() : null;
    const gating = isGatingWindow(provider, a.window, allowList);
    limits.push(
      makeLimit({
        id: `${provider}:${a.window}`,
        label: `${opts?.labelPrefix ?? provider} ${a.window}${a.labelExtra ? ` (${a.labelExtra})` : ""}`,
        usedPercent,
        remainingPercent,
        resetsAt,
        limitReached: exhausted,
        allowed: exhausted ? false : a.allowed ?? (remainingPercent !== null ? true : null),
        gating,
        observedAt,
        models: opts?.models ?? null,
      }),
    );
  }
  if (retryAfterSeconds !== null) {
    const base = observedAt ? Date.parse(observedAt) : NaN;
    const resetMs = (Number.isNaN(base) ? Date.now() : base) + retryAfterSeconds * 1000;
    limits.push(
      makeLimit({
        id: `${provider}:retry-after`,
        label: `${opts?.labelPrefix ?? provider} retry-after`,
        usedPercent: 100,
        remainingPercent: 0,
        resetsAt: new Date(resetMs).toISOString(),
        limitReached: true,
        allowed: false,
        // An explicit 429 watermark always limits, whatever the provider's
        // quota-window allow-list names: it is evidence of throttling, not a
        // quota window.
        gating: true,
        observedAt,
        models: opts?.models ?? null,
      }),
    );
  }
  if (Object.keys(signals).length > 0 && limits.length === 0 && retryAfterSeconds === null) {
    warnings.push(
      `${provider}: ${ignored} quota signal${ignored === 1 ? "" : "s"} carried no usable window; treating this observation as unknown.`,
    );
  }
  return { limits, observedAt, planType, warnings };
}

/**
 * Defensive fallback for window-object signal lists (older/guessed shapes):
 * `[{window|name, usedPercent|remainingPercent, resetAt, allowed,
 * limitReached}]`. Unknown shapes become warnings + zero windows.
 */
export function parseLegacySignalList(
  provider: ProviderKey,
  signals: unknown,
  observedAt: string | null,
  allowList: string[],
  opts?: { models?: string[] | null; labelPrefix?: string },
): ParsedSignals {
  const warnings: string[] = [];
  const limits: UsageLimitRow[] = [];
  if (!Array.isArray(signals)) {
    warnings.push(`${provider}: quota signals are not a header map or window list; treating as unknown.`);
    return { limits, observedAt, planType: null, warnings };
  }
  for (const s of signals) {
    const o = asObj(s);
    if (!o) {
      warnings.push(`${provider}: skipping a malformed quota signal.`);
      continue;
    }
    const window = getStr(o, "window", "Window", "name", "Name", "id") ?? "signal";
    const used = getNum(o, "usedPercent", "used_percent", "UsedPercent", "utilization", "Utilization", "used");
    const remaining = getNum(o, "remainingPercent", "remaining_percent", "RemainingPercent", "remaining");
    const resetsAt = toIsoTimestamp(
      o.resetAt ?? o.reset_at ?? o.ResetAt ?? o.reset ?? o.Reset ?? o.resetsAt ?? o.nextReset ?? null,
    );
    const scope = o.scope ?? null;
    const spendBlocked = o.spend_control_blocked === true || o.spendControlBlocked === true;
    let usedPercent = used;
    let remainingPercent = remaining;
    if (usedPercent === null && remainingPercent !== null && remainingPercent >= 0 && remainingPercent <= 100) {
      usedPercent = 100 - remainingPercent;
    } else if (remainingPercent === null && usedPercent !== null && usedPercent >= 0 && usedPercent <= 150) {
      remainingPercent = Math.max(0, 100 - Math.min(100, usedPercent));
    }
    if (usedPercent === null && remainingPercent === null && !spendBlocked) {
      warnings.push(`${provider}: window ${JSON.stringify(window)} carries no usable percent; ignored.`);
      continue;
    }
    const exhausted = spendBlocked || (remainingPercent ?? 100) <= 0;
    limits.push(
      makeLimit({
        id: `${provider}:${window}`,
        label: `${opts?.labelPrefix ?? provider} ${window}${spendBlocked ? " (spend control blocked)" : ""}`,
        usedPercent,
        remainingPercent,
        resetsAt,
        limitReached: exhausted,
        allowed: exhausted ? false : true,
        gating: isGatingWindow(provider, window, allowList, { scope, spendControl: spendBlocked }),
        observedAt,
        models: opts?.models ?? null,
      }),
    );
  }
  return { limits, observedAt, planType: null, warnings };
}

/* ------------------------------------------------------------------ */
/* auth-files account extraction                                       */
/* ------------------------------------------------------------------ */

export interface ParsedAccount {
  /** Stable row key (`acct-<sha256[0..16]>`; never a raw identifier). */
  key: string;
  /**
   * Raw CLIProxy provider string (trimmed, lowercased) — the identity used
   * for grouping, config matching, drift and routing. Never normalized:
   * every provider (including future ones like `openrouter`) keeps its own
   * group, and `minimax` never merges into `nvidia-nim`.
   */
  provider: string;
  /** Raw provider word from the entry, for UI labels. */
  channel: string;
  /**
   * Auth-file `name` for the per-credential served-set fetch
   * (`GET auth-files/models?name=<file>`), or null when the entry carries
   * none. Never sent unless it passes the management client's safe-name
   * check; files without a usable name keep the `model_quotas` heuristic.
   */
  fileName: string | null;
  /** Reconciled lifecycle state. */
  status: AccountStatus;
  /** CLIProxy `status_message`, when present (operational note). */
  statusMessage: string | null;
  /** Entry `priority` (burn order), when exposed. */
  priority: number | null;
  limits: UsageLimitRow[];
  planType: string | null;
  checkedAt: string;
  quotaBlind: boolean;
  accountHash: string | null;
  coolingDown: boolean;
  cooldownUntil: string | null;
  parseWarnings: string[];
}

/**
 * Extract per-account observations from an `auth-files` payload.
 *
 * Shape-tolerant: accepts an array of entries or `{files:[...]}` /
 * `{auth_files:[...]}` / `{authFiles:[...]}` / `{accounts:[...]}` /
 * `{entries:[...]}` / `{data:[...]}` wrappers. Every entry needs a stable
 * identity (`id`, else `path`); entries without one are counted, warned
 * about, and ignored — never trusted (TWO-579 identity rule). `disabled`
 * entries are stored (informational) but excluded from aggregation.
 */
export function parseAuthFiles(
  payload: unknown,
  opts: {
    now: string;
    allowLists: Record<string, string[]>;
    /**
     * Raw plugin-quota payloads by provider. Each is parsed with the owning
     * provider's own allow-list and attached to every enabled account row of
     * that provider (fetched at sync time, so as fresh as the cache row).
     */
    pluginPayloadByProvider?: Map<string, unknown>;
  },
): { accounts: ParsedAccount[]; unkeyed: number; warnings: string[] } {
  const warnings: string[] = [];
  const accounts: ParsedAccount[] = [];
  let unkeyed = 0;

  const root = asObj(payload);
  const entries: unknown[] = Array.isArray(payload)
    ? payload
    : root
      ? (["files", "auth_files", "authFiles", "accounts", "entries", "data", "items", "results"]
          .map((k) => (root as Json)[k])
          .find((v) => Array.isArray(v)) as unknown[]) ?? []
      : [];
  if (entries.length === 0) {
    warnings.push("auth-files payload holds no entries; every configured provider will drift-warn as having no enabled accounts.");
    return { accounts, unkeyed, warnings };
  }

  const seenKeys = new Map<string, number>();
  for (const e of entries) {
    const entry = asObj(e);
    if (!entry) {
      unkeyed += 1;
      warnings.push("skipping a non-object auth-files entry.");
      continue;
    }
    const channel =
      getStr(entry, "provider", "Provider", "type", "Type", "channel", "Channel", "kind") ?? "unknown";
    // Raw identity (trimmed, lowercased) — never the parser key. Config rows,
    // drift and routing match on this string exactly.
    const rawProvider = channel.trim().toLowerCase();
    const provider = rawProvider || "unknown";
    // The parser key chooses only the quota parser and the admission-signal
    // class; unknown providers fall back to the generic (quota-blind) parser.
    const parserKey = normalizeProvider(provider);
    const fileName = getStr(entry, "name", "Name") ?? null;

    // Stable identity: CLIProxy `id` first, then the auth-file `path`.
    const stableId = getStr(entry, "id", "ID", "auth_id") ?? getStr(entry, "path", "Path") ?? null;
    if (!stableId) {
      unkeyed += 1;
      warnings.push(
        `${channel}: entry without a stable id/path cannot be keyed across syncs; ignoring its quota.`,
      );
      continue;
    }
    let key = `acct-${hashIdentity([stableId])?.slice(0, 16) ?? "unknown"}`;
    const dupes = seenKeys.get(key) ?? 0;
    seenKeys.set(key, dupes + 1);
    if (dupes > 0) {
      warnings.push(`${channel}: duplicate auth-files identity for row ${key}; keeping the first, ignoring the repeat.`);
      continue;
    }

    const disabled = entry.disabled === true;
    const unavailable = entry.unavailable === true;
    const nextRetryAfter = toIsoTimestamp(entry.next_retry_after ?? entry.nextRetryAfter ?? null);
    const nowMs = Date.parse(opts.now);
    const retryFuture = nextRetryAfter !== null && !Number.isNaN(nowMs) && Date.parse(nextRetryAfter) > nowMs;
    const status: AccountStatus = disabled
      ? "disabled"
      : unavailable
        ? retryFuture
          ? "cooling"
          : "error"
        : "active";
    const statusMessage = getStr(entry, "status_message", "statusMessage", "StatusMessage");
    const priorityRaw = entry.priority ?? entry.Priority ?? null;
    const priority =
      typeof priorityRaw === "number" && Number.isFinite(priorityRaw)
        ? priorityRaw
        : typeof priorityRaw === "string" && priorityRaw.trim() !== "" && Number.isFinite(Number(priorityRaw))
          ? Number(priorityRaw)
          : null;

    // Operator overrides keyed by the raw string win; otherwise the parser
    // key's defaults apply (e.g. a `cloudflare-workers-ai` row inherits the
    // `cloudflare` windows). Unknown providers carry no allow-list.
    const allowList = opts.allowLists[provider] ?? opts.allowLists[parserKey] ?? [];
    // NIM is local-estimate only: its numbers ride along as non-gating
    // context (soft signal), and the account stays quota-blind for routing.
    const softGating = parserKey === "nvidia-nim";
    const labelPrefix =
      parserKey === "claude" ? "Claude unified" : parserKey === "codex" ? "Codex" : parserKey === "devin" ? "Devin" : provider;

    // Passive account-level observation.
    const quota = getObj(entry, "quota", "Quota", "observation", "usage");
    const observedAt = quota
      ? (toIsoTimestamp(quota.observed_at ?? quota.observedAt ?? quota.observedAtMs ?? null) ?? null)
      : null;
    if (quota && !observedAt) {
      // Passive signals refresh only when the account serves traffic; without
      // their own observed_at the observation is one step less trustworthy.
    }
    const signalInputs: Array<{ signals: Record<string, unknown>; observed: string | null; models: string[] | null }> = [];
    if (quota) {
      const rawSignals: unknown = quota.signals ?? quota.Signals ?? null;
      if (rawSignals !== null && typeof rawSignals === "object" && !Array.isArray(rawSignals)) {
        signalInputs.push({ signals: rawSignals as Record<string, unknown>, observed: observedAt, models: null });
      } else if (Array.isArray(rawSignals)) {
        signalInputs.push({ signals: { __legacy: rawSignals } as unknown as Record<string, unknown>, observed: observedAt, models: null });
      } else if (rawSignals !== null) {
        // Present but unparseable: counts as an observation with no windows.
        signalInputs.push({ signals: {}, observed: observedAt, models: null });
      }
    }

    // Per-model observations: CLIProxy keys them by model
    // (`model_quotas: {<model>: {observed_at, signals}}`).
    const modelQuotas: unknown = entry.model_quotas ?? entry.modelQuotas ?? entry.ModelQuotas ?? null;
    if (modelQuotas && typeof modelQuotas === "object" && !Array.isArray(modelQuotas)) {
      for (const [model, obs] of Object.entries(modelQuotas as Record<string, unknown>)) {
        const o = asObj(obs);
        if (!o) continue;
        const mObserved = toIsoTimestamp(o.observed_at ?? o.observedAt ?? null) ?? null;
        const mSignals: unknown = o.signals ?? o.Signals ?? null;
        if (mSignals !== null && typeof mSignals === "object" && !Array.isArray(mSignals)) {
          signalInputs.push({ signals: mSignals as Record<string, unknown>, observed: mObserved, models: [model.toLowerCase()] });
        }
      }
    } else if (Array.isArray(modelQuotas)) {
      for (const mq of modelQuotas) {
        const o = asObj(mq);
        if (!o) continue;
        const model = getStr(o, "model", "Model", "window", "name") ?? null;
        const mObserved = toIsoTimestamp(o.observed_at ?? o.observedAt ?? null) ?? null;
        const mSignals: unknown = o.signals ?? o.Signals ?? null;
        if (mSignals !== null && typeof mSignals === "object" && !Array.isArray(mSignals)) {
          signalInputs.push({
            signals: mSignals as Record<string, unknown>,
            observed: mObserved,
            models: model ? [model.toLowerCase()] : null,
          });
        }
      }
    }

    const limits: UsageLimitRow[] = [];
    const parseWarnings: string[] = [];
    let planType: string | null =
      getStr(entry, "plan", "planType", "Plan", "account_type", "AccountType") ?? null;
    for (const input of signalInputs) {
      if ("__legacy" in input.signals) {
        const parsed = parseLegacySignalList(parserKey, (input.signals as Record<string, unknown>).__legacy, input.observed, allowList, {
          models: input.models,
          labelPrefix,
        });
        parseWarnings.push(...parsed.warnings);
        limits.push(...stampLimits(parsed.limits, input.observed, opts.now));
        continue;
      }
      const parsed = parseHeaderSignals(parserKey, input.signals, input.observed, allowList, {
        models: input.models,
        labelPrefix,
      });
      parseWarnings.push(...parsed.warnings);
      if (Object.keys(input.signals).length === 0) {
        parseWarnings.push(`${provider}: account observation carries no quota signals; treating as unknown.`);
      }
      limits.push(...stampLimits(parsed.limits, input.observed, opts.now));
      if (!planType && parsed.planType) planType = parsed.planType;
    }

    const pluginPayload = opts.pluginPayloadByProvider?.get(provider);
    let pluginQuota: ParsedPluginQuota | null = null;
    if (pluginPayload !== undefined && !disabled) {
      pluginQuota = parsePluginQuota(parserKey, pluginPayload, allowList, {
        softGating,
        // Plugin-quota limits are fetched right now: their observation time is
        // the sync's fetch time, never the passive `observed_at`.
        observedAt: opts.now,
      });
    }
    const pluginLimits: UsageLimitRow[] = pluginQuota?.limits ?? [];
    if (pluginQuota?.planType) planType = pluginQuota.planType;

    const stamped = softGating
      ? [...limits.map((l) => ({ ...l, gating: false })), ...pluginLimits]
      : [...limits, ...pluginLimits];

    const quotaBlind =
      parserKey === "meta" ||
      parserKey === "antigravity" ||
      parserKey === "xai" ||
      parserKey === "kimi" ||
      parserKey === "compat" ||
      parserKey === "unknown-provider" ||
      parserKey === "nvidia-nim" ||
      (stamped.length === 0 && pluginLimits.length === 0);

    if (quota && !observedAt) {
      parseWarnings.push(`${provider}: observation has no usable observed_at; using fetch time.`);
    }

    accounts.push({
      key,
      provider,
      channel,
      fileName,
      status,
      statusMessage,
      priority,
      limits: stamped,
      planType,
      // Cache age: the sync's own fetch time. It drives the bounded fail-open
      // then unknown when sync dies — never the passive observed_at, which
      // only refreshes when the account serves traffic (an idle healthy
      // account must not be shut out for good).
      checkedAt: opts.now,
      quotaBlind,
      accountHash: hashIdentity([
        getStr(entry, "account_id", "accountId", "id"),
        getStr(entry, "email", "Email", "login"),
        getStr(entry, "label", "name"),
        getStr(entry, "account", "Account"),
        getStr(entry, "project_id", "projectId"),
        channel,
        stableId,
      ]),
      coolingDown: unavailable,
      // Keep a past retry time: it lets the aggregator tell "cooldown lifted,
      // no fresh telemetry" (unknown) apart from "no recovery bound at all"
      // (out). Nulling it here dead-coded that branch and re-waited forever.
      cooldownUntil: nextRetryAfter,
      parseWarnings: [...parseWarnings, ...(pluginQuota?.warnings ?? [])],
    });
  }
  return { accounts, unkeyed, warnings };
}

/**
 * Passive limits without their own observed_at inherit the fetch time — the
 * parser already warned that the observation is one step less trustworthy —
 * so every window carries an explicit observation time.
 */
function stampLimits(limits: UsageLimitRow[], observed: string | null, fetchNow: string): UsageLimitRow[] {
  if (observed) return limits;
  return limits.map((l) => (l.observedAt ? l : { ...l, observedAt: fetchNow }));
}
