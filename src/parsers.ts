/**
 * Per-provider quota parsers (TWO-578 spike matrix §2 + §3.3 + §6).
 *
 * Every parser normalizes into `UsageLimitRow[]` with the same field names as
 * `shared/ai-connection-usage.d.ts`, so the later core hook is a format no-op.
 * The iron rule: missing provider data is `unknown`, never headroom. A parser
 * that cannot understand a payload returns zero gating windows (quota-blind)
 * instead of guessing.
 *
 * Two payload shapes are consumed (proposal §4 GET allow-list):
 * 1. `auth-files` entries: passive per-credential observations for Claude,
 *    Codex and Devin (`quota{observed_at, signals}`, `model_quotas`), plus
 *    cooldown state. Exact JSON is operator-captured (spike §8 item 8), so
 *    extraction is defensive: unknown shapes become warnings + quota-blind.
 * 2. Plugin quota routes: the normalized `QuotaFetchResponse` shape
 *    (`Subscription`, `Summary`, `Groups[].Buckets[]` with `Window`,
 *    `RemainingFraction`, `ResetTime`) our five provider plugins return.
 */

import { createHash } from "node:crypto";
import type { UsageLimitRow } from "./types.js";

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

/** Normalize a CLIProxy channel / provider word into a parser key. */
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
  if (c.includes("nvidia") || c.includes("nim")) return "nvidia-nim";
  if (c.includes("cloudflare")) return "cloudflare";
  if (c === "zai" || c.includes("zai") || c.includes("glm") || c.includes("zhipu")) return "zai";
  return "unknown-provider";
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
  return allowList.some((sub) => sub !== "" && id.includes(sub.toLowerCase()));
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
  warnings: string[];
}

/**
 * Parse passive per-credential quota signals from an `auth-files` entry.
 * Claude: `Anthropic-Ratelimit-Unified-*` (5h / 7d / Fable windows,
 * utilization + reset). Codex: `X-Codex-*` (per-window used-percent,
 * window-minutes, reset-at, credits, plan-type). Devin: Devin-shaped windows
 * mapped conservatively (window id kept verbatim, percents as reported).
 *
 * Signals exist only after traffic and go stale — the freshness bound is the
 * router's job. Here `observed_at` becomes the observation time; when it is
 * missing the caller substitutes the fetch time and the observation is
 * already one step less trustworthy (recorded as a warning).
 */
export function parsePassiveSignals(
  provider: ProviderKey,
  quota: Json | null,
  allowList: string[],
): ParsedSignals {
  const warnings: string[] = [];
  const limits: UsageLimitRow[] = [];
  if (!quota) {
    warnings.push(`${provider}: no quota observation on this account.`);
    return { limits, observedAt: null, warnings };
  }
  const observedAt =
    toIsoTimestamp(quota.observed_at ?? quota.observedAt ?? quota.observedAtMs ?? null) ?? null;
  if (!observedAt) warnings.push(`${provider}: observation has no usable observed_at; using fetch time.`);

  const signals = quota.signals;
  const signalList: Json[] = Array.isArray(signals)
    ? signals.filter((s): s is Json => asObj(s) !== null)
    : asObj(signals)
      ? Object.entries(signals as Json).map(([name, value]) => ({ name, ...(asObj(value) ?? { value }) }))
      : [];
  const modelQuotas = Array.isArray(quota.model_quotas) ? quota.model_quotas : [];

  const push = (windowId: string, fields: Json, labelPrefix: string) => {
    const used =
      getNum(fields, "usedPercent", "used_percent", "UsedPercent", "utilization", "Utilization", "used") ??
      null;
    const remaining =
      getNum(fields, "remainingPercent", "remaining_percent", "RemainingPercent", "remaining") ?? null;
    const resetsAt = toIsoTimestamp(
      fields.resetAt ??
        fields.reset_at ??
        fields.ResetAt ??
        fields.reset ??
        fields.Reset ??
        fields.resetsAt ??
        fields.nextReset ??
        null,
    );
    const scope = fields.scope ?? null;
    const spendBlocked =
      fields.spend_control_blocked === true ||
      fields.spendControlBlocked === true ||
      getStr(fields, "spend_control", "spendControl") === "blocked";
    let usedPercent = used;
    let remainingPercent = remaining;
    if (usedPercent === null && remainingPercent !== null && remainingPercent >= 0 && remainingPercent <= 100) {
      usedPercent = 100 - remainingPercent;
    } else if (remainingPercent === null && usedPercent !== null && usedPercent >= 0 && usedPercent <= 150) {
      remainingPercent = Math.max(0, 100 - Math.min(100, usedPercent));
    }
    if (usedPercent === null && remainingPercent === null && !spendBlocked) {
      warnings.push(`${provider}: window ${JSON.stringify(windowId)} carries no usable percent; ignored.`);
      return;
    }
    const exhausted = spendBlocked || (remainingPercent ?? 100) <= 0;
    limits.push(
      makeLimit({
        id: `${provider}:${windowId}`,
        label: `${labelPrefix} ${windowId}${spendBlocked ? " (spend control blocked)" : ""}`,
        usedPercent,
        remainingPercent,
        resetsAt,
        limitReached: exhausted,
        allowed: exhausted ? false : true,
        gating: isGatingWindow(provider, windowId, allowList, { scope, spendControl: spendBlocked }),
        // Passive signals refresh only when the account serves traffic; null
        // (no usable observed_at) falls back to the sync fetch time upstream.
        observedAt,
      }),
    );
  };

  for (const s of signalList) {
    const name = getStr(s, "window", "Window", "name", "Name", "id") ?? getStr(s, "name") ?? "signal";
    push(name, s, provider === "claude" ? "Claude unified" : provider === "codex" ? "Codex" : "Devin");
  }
  for (const m of modelQuotas) {
    const mq = asObj(m);
    if (!mq) continue;
    const name = getStr(mq, "window", "Window", "name", "model") ?? "model-quota";
    push(name, mq, provider === "claude" ? "Claude model" : provider === "codex" ? "Codex model" : "Devin model");
  }
  return { limits, observedAt, warnings };
}

/* ------------------------------------------------------------------ */
/* auth-files account extraction                                       */
/* ------------------------------------------------------------------ */

export interface ParsedAccount {
  prefix: string;
  provider: ProviderKey;
  /** Raw channel word from the entry, for UI labels. */
  channel: string;
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
 * `{auth_files:[...]}` / `{accounts:[...]}` wrappers. Every entry needs a
 * single-segment `prefix` — entries without one cannot be keyed to the
 * operator map and are reported as `unkeyed-observation` drift, never
 * trusted (TWO-579 identity rule).
 */
export function parseAuthFiles(
  payload: unknown,
  opts: {
    now: string;
    allowLists: Record<string, string[]>;
    /**
     * Raw plugin-quota payloads by prefix. Each is parsed with the owning
     * account's own provider + allow-list (per-provider gating stays exact).
     */
    pluginPayloadByPrefix?: Map<string, unknown>;
  },
): { accounts: ParsedAccount[]; unkeyed: number; warnings: string[] } {
  const warnings: string[] = [];
  const accounts: ParsedAccount[] = [];
  let unkeyed = 0;

  const root = asObj(payload);
  const entries: unknown[] = Array.isArray(payload)
    ? payload
    : root
      ? (["files", "auth_files", "authFiles", "accounts", "entries"]
          .map((k) => (root as Json)[k])
          .find((v) => Array.isArray(v)) as unknown[]) ?? []
      : [];
  if (entries.length === 0) {
    warnings.push("auth-files payload holds no entries; every mapped account will drift-warn as missing.");
    return { accounts, unkeyed, warnings };
  }

  for (const e of entries) {
    const entry = asObj(e);
    if (!entry) {
      unkeyed += 1;
      warnings.push("skipping a non-object auth-files entry.");
      continue;
    }
    const prefix = getStr(entry, "prefix", "Prefix");
    const channel =
      getStr(entry, "channel", "provider", "kind", "type", "Provider", "Channel") ?? "unknown";
    const provider = normalizeProvider(channel);
    if (!prefix || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(prefix)) {
      unkeyed += 1;
      warnings.push(
        `${channel}: entry without a single-segment prefix cannot be keyed to the map; ignoring its quota.`,
      );
      continue;
    }

    const quota = getObj(entry, "quota", "Quota", "observation", "usage");
    const allowList = opts.allowLists[provider] ?? [];
    // NIM is local-estimate only: its numbers ride along as non-gating
    // context (soft signal), and the account stays quota-blind for routing.
    const softGating = provider === "nvidia-nim";
    // The per-window observation times ride on each limit's `observedAt`;
    // the row-level `observedAt` is intentionally not used for `checkedAt`
    // (cache age is the fetch time — see below).
    const { limits, warnings: sigWarnings } = parsePassiveSignals(provider, quota, allowList);

    const pluginPayload = opts.pluginPayloadByPrefix?.get(prefix);
    let pluginQuota: ParsedPluginQuota | null = null;
    if (pluginPayload !== undefined) {
      pluginQuota = parsePluginQuota(provider, pluginPayload, allowList, {
        softGating: softGating,
        // Plugin-quota limits are fetched right now: their observation time is
        // the sync's fetch time, never the passive `observed_at`.
        observedAt: opts.now,
      });
    }
    const pluginLimits: UsageLimitRow[] = pluginQuota?.limits ?? [];
    let planType: string | null = getStr(entry, "plan", "planType", "Plan") ?? null;
    if (pluginQuota?.planType) planType = pluginQuota.planType;

    const cooling =
      getObj(entry, "cooldown", "Cooldown") ?? (entry.cooling_down || entry.coolingDown ? entry : null);
    const co = asObj(cooling);
    const coolingDown =
      co?.active === true ||
      co?.cooling === true ||
      entry.cooling_down === true ||
      entry.coolingDown === true ||
      getNum(co ?? {}, "next_recover_at", "nextRecoverAt") !== null;
    const cooldownUntil = coolingDown
      ? (toIsoTimestamp(co?.next_recover_at ?? co?.nextRecoverAt ?? co?.until ?? null) ?? null)
      : null;

    const quotaBlind =
      provider === "meta" ||
      provider === "antigravity" ||
      provider === "xai" ||
      provider === "kimi" ||
      provider === "compat" ||
      provider === "unknown-provider" ||
      provider === "nvidia-nim" ||
      (limits.length === 0 && pluginLimits.length === 0);

    // Passive limits without their own observed_at inherit the fetch time —
    // the parser already warned that the observation is one step less
    // trustworthy — so every window carries an explicit observation time.
    const stampedPassive = limits.map((l) => (l.observedAt ? l : { ...l, observedAt: opts.now }));
    accounts.push({
      prefix,
      provider,
      channel,
      limits: softGating ? [...stampedPassive.map((l) => ({ ...l, gating: false })), ...pluginLimits] : [...stampedPassive, ...pluginLimits],
      planType,
      // Cache age: the sync's own fetch time. It drives the bounded fail-open
      // then fail-closed when sync dies — never the passive observed_at, which
      // only refreshes when the account serves traffic (an idle healthy
      // account must not be shut out for good).
      checkedAt: opts.now,
      quotaBlind,
      accountHash: hashIdentity([
        getStr(entry, "account_id", "accountId", "id"),
        getStr(entry, "email", "Email", "login"),
        getStr(entry, "label", "name"),
        channel,
        prefix,
      ]),
      coolingDown,
      cooldownUntil,
      parseWarnings: [...sigWarnings, ...(pluginQuota?.warnings ?? [])],
    });
  }
  return { accounts, unkeyed, warnings };
}
