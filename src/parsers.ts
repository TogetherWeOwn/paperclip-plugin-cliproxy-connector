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
 *    `retry-after`, …) — see `quota_signals.go` in CLIProxyAPI. CLIProxy
 *    always sends the `quota:{signals:{}}` shell, even for providers that
 *    publish no passive signals: an empty shell with no `observed_at` is
 *    expected, not a warning. Exact live management JSON is still
 *    operator-captured when available; until then the fixture in
 *    `sync.test.ts` mirrors the source shapes above.
 * 2. Plugin quota routes: the normalized `QuotaFetchResponse` shape our
 *    provider plugins return, serialized with lowercase JSON tags
 *    (`subscription{plan,…}`, `summary[]`, `groups[].buckets[]` with
 *    `window`, `remainingFraction`, `resetTime`, `description`). Devin
 *    daily/weekly windows come primarily from auth-files passive signals
 *    (see `parseHeaderSignals`): the `daily|weekly_quota_remaining_percent`
 *    / `daily|weekly_quota_reset_at` fields sometimes echoed at the plugin
 *    payload root are accepted only as a fallback.
 */

import { createHash } from "node:crypto";
import { SINGLE_SEGMENT } from "./config.js";
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
 * Credential `auth_index` from an `auth-files` entry. Upstream serializes it
 * as a string (`auth_files_fields.go`: `AuthIndex string`), but a numeric
 * shape is accepted shape-tolerantly: only a non-negative safe integer, and
 * only as its plain decimal rendering. Anything else (floats, negatives,
 * unsafe integers, booleans, objects) reads as absent, and the value still
 * passes the management client's `isSafeAuthIndex` check before any fetch.
 */
function getAuthIndex(o: Json, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
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

/**
 * Scrub an upstream `status_message` before it reaches the plugin page.
 * Emails become `[redacted-email]`; any whitespace-delimited token that
 * looks credential-like — a 20+ word-char run, or 8+ chars mixing letters
 * with digits (short API keys, session ids) — becomes `[redacted]`. Tokens
 * with operational shapes (timestamps, versions, benign `k=v` pairs like
 * `error=429`, lowercase hyphenated slugs like model ids) pass through so
 * the page keeps reset times and model names. The note is capped at
 * 120 chars. Plain notes ("ok", "429 rate limited") pass through unchanged.
 */
export function sanitizeStatusMessage(raw: string | null): string | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s) return null;
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]");
  s = s
    .split(/\s+/)
    .map((tok) => {
      if (tok === "[redacted-email]") return tok;
      if (/[A-Za-z0-9_\-]{20,}/.test(tok)) return "[redacted]";
      // Judge the punctuation-stripped core: real notes attach commas and
      // periods ("for gpt-4o-mini, retry"), which must not defeat the
      // operational-shape exemption.
      const core = tok.replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9]+$/, "");
      if (isCredentialCore(core)) return "[redacted]";
      return tok;
    })
    .join(" ");
  if (s.length > 120) s = `${s.slice(0, 117)}...`;
  return s;
}

/**
 * A letter+digit token that is operational, not a credential: timestamps,
 * versions and URLs (punctuation bare keys/session ids almost never
 * contain), `k=v` pairs whose value is not itself credential-shaped
 * (`error=429` keeps; `token=ab12cd34ef` redacts), and lowercase hyphenated
 * slugs without credential tells (`gpt-4o-mini`, `claude-sonnet-4-5` model
 * ids pass; `sk-live-abc123` and `sk-live-a1b2c3d4` still redact).
 * `:`/`/` tokens are operational only when no separated segment is itself
 * credential-shaped (`error=429` and `HTTP/1.1` keep; `token:ab12cd34ef`
 * redacts). Dots stay inside the slug judgment as version separators
 * (`claude-3.5-sonnet` keeps), with a per-segment fallback for hostnames and
 * dotted versions (`s3.amazonaws.com`, `v1.2.3-beta1` keep) that still rejects
 * dotted credentials (`sk.live.a1.b2` redacts). A strong dot-segment cannot
 * launder a secret-shaped token: a leading secret marker (`sk`, `secret`,
 * `token`, …) or two flat letter-digit fragments (`a1`, `b2`) deny the
 * hostname/version fallback, so `sk.production.a1.b2` redacts while
 * `s3.amazonaws.com` (one flat fragment) and `v1.2.3-beta1` (a hyphenated
 * prerelease part plus a bare version number) keep. Several flat mixed
 * labels deny the fallback unless every one is version/hostname structured
 * (`v1`, `us2`, `3rc1`) beside a structural part — a bare number anywhere or
 * a strong word with more hostname after it — so `v1.2.3rc1` and
 * `s3.us2.amazonaws.com` keep while a trailing payload word
 * (`a1.b2.production`) and interleaved entropy (`a1b2.c3d4.99`) still redact.
 * Timestamps are exempted
 * only when the whole token is a date/time, fractional seconds and numeric
 * offsets included (`2026-11-01T12:00:00.000Z` and `...+00:00` keep), so a
 * date substring cannot launder attached secret material
 * (`sk-2026-11-01-ab12` redacts).
 */
function isOperationalToken(tok: string): boolean {
  const eq = tok.lastIndexOf("=");
  if (eq >= 0) return !isCredentialCore(tok.slice(eq + 1));
  if (
    /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(tok) ||
    /^\d{2}:\d{2}(:\d{2})?$/.test(tok)
  )
    return true;
  if (tok.includes(".")) {
    // Judge the dotted token as one slug first, so version continuations
    // (`5-sonnet` in `claude-3.5-sonnet`) are not mistaken for credentials.
    if (isSlugLike(tok.replace(/\./g, "-"), 1)) return true;
    const segs = tok.split(".");
    if (segs.some((seg) => isCredentialCore(seg))) return false;
    // A secret marker up front (`sk`, `secret`, `token`, …) means the rest
    // of the labels are key material, not a hostname — however
    // operational one of them looks on its own (`production`).
    if (segs.length > 1 && SECRET_DOT_PREFIX.test(segs[0] ?? "")) return false;
    // Segmented secrets spread entropy across several flat letter-digit
    // labels (`a1.b2`); hostnames carry version-shaped ones (`s3`, `us2`),
    // and dotted versions structure theirs (`3rc1`, `3-beta1`). Two or more
    // flat mixed labels deny the fallback — unless every one is
    // version/hostname structured and another segment is clearly operational
    // (a bare number or long word), so `v1.2.3rc1` and
    // `s3.us2.amazonaws.com` keep while interleaved entropy (`a1b2.c3d4.99`)
    // still redacts. A leading secret marker already denied above.
    const flatMixed = segs.filter(
      (seg) => !seg.includes("-") && /[a-zA-Z]/.test(seg) && /[0-9]/.test(seg),
    );
    // The clearly operational part must be structural, not a trailing payload
    // word: a bare number (a version component) anywhere, or a strong word
    // with more hostname after it. `a1.b2.production` ends on its payload
    // word and redacts; `s3.us2.amazonaws.com` continues past `amazonaws`
    // and `v1.2.3rc1` carries the bare `2`, so both keep.
    const justified =
      segs.some((seg) => /^[0-9]+$/.test(seg)) || segs.slice(0, -1).some(isStrongDotPart);
    if (flatMixed.length >= 2 && !(flatMixed.every(isVersionShapedPart) && justified))
      return false;
    return segs.some(isStrongDotPart);
  }
  if (/[/:]/.test(tok)) return !tok.split(/[/:]/).some((seg) => isCredentialCore(seg));
  return isSlugLike(tok.replace(/\./g, "-"));
}

/** 8+ chars mixing letters with digits: a short key/session id shape. */
function isCredentialCore(core: string): boolean {
  return (
    core.length >= 8 &&
    /[A-Za-z]/.test(core) &&
    /[0-9]/.test(core) &&
    !isOperationalToken(core)
  );
}

/**
 * A leading dot-segment that marks a dotted token as secret-shaped: the
 * usual key-material prefixes. Common subdomain words (`api`, `auth`) are
 * deliberately absent — `api.example.com` keeps via the slug judgment or
 * the fallback, and must not redact.
 */
const SECRET_DOT_PREFIX =
  /^(sk|secret|secrets|key|keys|token|tokens|bearer|session|password|passwd|pwd|private|credentials?)$/i;

/**
 * A dot-separated segment that marks a dotted token operational on its own:
 * a real word (`amazonaws`) or a bare version number (`2`). Short entropy
 * fragments (`a1`, `sk`) do not count.
 */
function isStrongDotPart(seg: string): boolean {
  return /^[a-z]{5,}$/.test(seg) || /^[0-9]+$/.test(seg);
}

/**
 * A flat letter-digit label shaped like a version or hostname part: one run
 * of letters against one run of digits (`v1`, `s3`, `us2`, `3rc1`, `2beta1`).
 * Interleaved entropy (`a1b2`, `ab12cd`) does not count.
 */
function isVersionShapedPart(seg: string): boolean {
  return /^[a-zA-Z]+[0-9]+$/.test(seg) || /^[0-9]+[a-zA-Z]+[0-9]*$/.test(seg);
}

/**
 * Lowercase hyphenated slug (`gpt-4o-mini`) that is not credential-shaped.
 * Every non-initial segment must be a model-id part: a word (`mini`), a
 * small number (`4`, `70`), a leading run plus letters (`4o`, `70b`), or a
 * trailing single digit (`v3`, `o1`). Anything else — an internal digit run
 * (`abc123def`), a trailing run (`abc123`), interleaved alphanumerics
 * (`a1b2c3d4`) — reads as a credential and redacts. Mixed letter-digit
 * segments may not outnumber the plain words: model ids are mostly words
 * with version annotations (`gpt-4o-mini-v2` keeps), while segmented
 * credentials spread their entropy across many mixed parts
 * (`sk-live-a1-b2-c3-d4` redacts). Callers judging dotted tokens pass an
 * explicit budget of 1, since dots already had their own fallback.
 */
function isSlugLike(core: string, maxMixed?: number): boolean {
  const parts = core.split("-");
  if (parts.length < 2 || !/^[a-z]+$/.test(parts[0] as string)) return false;
  const rest = parts.slice(1) as string[];
  const mixed = rest.filter((seg) => /[a-z]/.test(seg) && /[0-9]/.test(seg));
  const budget = maxMixed ?? parts.filter((seg) => /^[a-z]+$/.test(seg)).length;
  if (mixed.length > budget) return false;
  return rest.every(
    (seg) =>
      /^[a-z]+$/.test(seg) ||
      /^[0-9]{1,4}$/.test(seg) ||
      /^[0-9]+[a-z]+$/.test(seg) ||
      /^[a-z]+[0-9]$/.test(seg),
  );
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
  | "openrouter"
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
  if (c.includes("openrouter")) return "openrouter";
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
  metrics?: string[] | null;
  viaProviderApi?: boolean | null;
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
    metrics: init.metrics ?? null,
    viaProviderApi: init.viaProviderApi ?? null,
  };
}

/**
 * Emit an expected live window whose percent is missing or unusable. The row
 * carries no usable percent, so aggregation treats it as unknown rather than
 * letting a sibling usable window imply full coverage: an unknown window
 * still vetoes headroom, but it must never read as exhaustion. For an
 * admission-signal provider an `allowed: null` row would read as limiting
 * (fail closed), so a caller that knows the plan exists passes
 * `allowed: true` — admission is not denied, only the percent telemetry is
 * missing (`remainingPercent: null` keeps the verdict unknown). The row still
 * marks the window as expected, so it clears quota-blind when at least one
 * gating window was expected. Genuine exhaustion keeps flowing through the
 * usable branch with an explicit `allowed: false`.
 */
function makeUnknownProviderWindow(args: {
  provider: "meta" | "devin";
  id: string;
  label: string;
  observedAt: string | null;
  allowList: string[];
  allowed?: boolean | null;
}): UsageLimitRow {
  return makeLimit({
    id: `${args.provider}:${args.id}`,
    label: args.label,
    usedPercent: null,
    remainingPercent: null,
    resetsAt: null,
    limitReached: false,
    allowed: args.allowed ?? null,
    gating: isGatingWindow(args.provider, args.id, args.allowList),
    observedAt: args.observedAt,
    viaProviderApi: true,
  });
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
 * Display-only quota `summary[]` entries, normalized to short strings.
 * Payload- and bucket-level summaries merge onto every emitted window row
 * (`metrics`, never gating). Upstream text can carry account identifiers, so
 * every entry is scrubbed like status notes (emails and credential-like
 * tokens redacted) before it reaches the page. Non-string entries stringify
 * defensively; bounded (32 entries, 240 chars) so a chatty plugin cannot
 * bloat the cache.
 */
function summarizeMetrics(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value.slice(0, 32)) {
    const push = (raw: string) => {
      const clean = sanitizeStatusMessage(raw.slice(0, 240));
      if (clean) out.push(clean);
    };
    if (typeof item === "string" && item.trim()) push(item.trim());
    else if (typeof item === "number" && Number.isFinite(item)) push(String(item));
    else if (item !== null && typeof item === "object") {
      try {
        const s = JSON.stringify(item);
        if (s && s !== "{}" && s !== "[]") push(s);
      } catch {
        /* unstringifiable entry: dropped, never headroom */
      }
    }
  }
  return out.length > 0 ? out : null;
}

/**
 * Parse a Devin-style remaining-percent field (`"75%"`, `"75"` or `75`)
 * into 0–100 remaining. Returns null when the value is absent or unusable
 * (unknown, never headroom).
 */
function parseRemainingPercentField(value: unknown): number | null {
  let raw: string | number | null = null;
  if (typeof value === "number" && Number.isFinite(value)) raw = value;
  else if (typeof value === "string" && value.trim()) {
    const stripped = value.trim().replace(/%$/, "").trim();
    if (stripped && Number.isFinite(Number(stripped))) raw = Number(stripped);
  }
  if (raw === null || raw < 0 || raw > 100) return null;
  return raw;
}

/**
 * Display-only blind reason for a quota-blind account row. Meta reads live
 * through the downloaded auth file plus the `muse-code/key` call (see the
 * `api-call` template table in `src/cliproxy.ts`), so a blind Meta row means
 * the live read was disabled, throttled without a cache, or failed this run
 * — the sync warnings carry the concrete cause. Providers whose upstream
 * exposes no quota read "upstream exposes nothing"; NIM-style local estimates
 * read "local estimate"; a gated provider that simply reported no usable
 * windows reads "no usable quota windows".
 */
export function quotaBlindReason(parserKey: ProviderKey, hasWindows: boolean): string | null {
  switch (parserKey) {
    case "meta":
      return "Meta live read unavailable (see sync warnings)";
    case "antigravity":
    case "xai":
    case "kimi":
    case "compat":
    case "openrouter":
    case "unknown-provider":
      return "upstream exposes nothing";
    case "nvidia-nim":
      return "local estimate";
    default:
      return hasWindows ? null : "no usable quota windows";
  }
}

/**
 * Parse the normalized `QuotaFetchResponse` our provider plugins return
 * (lowercase wire tags: `subscription{plan,tierName,tierId}`, `summary[]`,
 * `groups[].buckets[]` with `window`, `remainingFraction`, `resetTime`,
 * `description`; PascalCase aliases accepted shape-tolerantly).
 *
 * Devin daily/weekly fallback: when the payload root carries
 * `daily|weekly_quota_remaining_percent` (trailing `%` stripped, with
 * `daily|weekly_quota_reset_at` / `daily|weekly_reset_at`), they parse into
 * `daily` / `weekly` windows under the same allow-list gating. This is only
 * a fallback — the primary source is the auth-files passive observation
 * (`quota.signals` on the Devin entry, parsed by `parseHeaderSignals`),
 * because no Devin plugin quota route serves these fields.
 *
 * Mapping: `usedPercent = (1 − remainingFraction) × 100`,
 * `resetsAt = resetTime`, `allowed = remainingFraction > 0`.
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

  // Payload-level `summary[]`: display-only context merged onto every row.
  const payloadMetrics = summarizeMetrics(root.Summary ?? root.summary ?? null);

  const groups = Array.isArray(root.Groups)
    ? root.Groups
    : Array.isArray(root.groups)
      ? root.groups
      : null;

  for (const g of groups ?? []) {
    const group = asObj(g);
    if (!group) {
      warnings.push(`${provider}: skipping a malformed quota group.`);
      continue;
    }
    // Wire shape is lowercase `buckets` (CLIProxyAPI `pluginapi` JSON tags);
    // PascalCase accepted shape-tolerantly. A group with no buckets array
    // parses to zero windows with a warning — never silent blindness.
    const buckets = Array.isArray(group.Buckets)
      ? group.Buckets
      : Array.isArray(group.buckets)
        ? group.buckets
        : null;
    if (!buckets || buckets.length === 0) {
      warnings.push(`${provider}: quota group has no buckets; treating this group as unknown.`);
      continue;
    }
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
      // Bucket-level `summary[]` merges with the payload-level entries.
      const bucketMetrics = summarizeMetrics(bucket.Summary ?? bucket.summary ?? null);
      const metrics =
        payloadMetrics || bucketMetrics ? [...(payloadMetrics ?? []), ...(bucketMetrics ?? [])] : null;

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
          models: null,
          metrics,
        }),
      );
    }
  }

  // Devin percent fields fallback (`daily_quota_remaining_percent` /
  // `weekly_quota_remaining_percent`, trailing `%` stripped) with
  // `daily|weekly_quota_reset_at` (also `daily|weekly_reset_at` tolerated).
  // Same gating, same observation. A Groups-less payload that carries only
  // these fields still parses — the missing-groups warning fires only when
  // no window came from either shape. Primary source stays the auth-files
  // passive signals (see `parseHeaderSignals`); this root shape exists only
  // for plugin payloads that echo the fields.
  for (const window of ["daily", "weekly"] as const) {
    const raw =
      root[`${window}_quota_remaining_percent`] ??
      root[`${window}QuotaRemainingPercent`] ??
      root[`${capitalize(window)}QuotaRemainingPercent`] ??
      null;
    if (raw === null || raw === undefined) continue;
    const remainingPercent = parseRemainingPercentField(raw);
    if (remainingPercent === null) {
      warnings.push(`${provider}: ${window} quota percent is unusable; skipping.`);
      continue;
    }
    const usedPercent = 100 - remainingPercent;
    const exhausted = remainingPercent <= 0;
    const gating =
      opts?.softGating === true ? false : isGatingWindow(provider, window, allowList);
    limits.push(
      makeLimit({
        id: `${provider}:${window}`,
        label: `${provider} ${window}`,
        usedPercent,
        remainingPercent,
        resetsAt: toIsoTimestamp(
          root[`${window}_quota_reset_at`] ??
            root[`${window}_reset_at`] ??
            root[`${window}QuotaResetAt`] ??
            root[`${window}ResetAt`] ??
            root[`${capitalize(window)}QuotaResetAt`] ??
            root[`${capitalize(window)}ResetAt`] ??
            null,
        ),
        limitReached: exhausted,
        allowed: exhausted ? false : true,
        gating,
        observedAt: opts?.observedAt ?? null,
        models: null,
        metrics: payloadMetrics,
      }),
    );
  }
  if (limits.length === 0 && (!groups || groups.length === 0)) {
    warnings.push(`${provider}: plugin quota payload has no Groups; treating as unknown.`);
  }
  return { planType, limits, warnings };
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/* ------------------------------------------------------------------ */
/* live provider-API quota (pinned api-call templates)                 */
/* ------------------------------------------------------------------ */

export interface ParsedApiQuota {
  planType: string | null;
  limits: UsageLimitRow[];
  warnings: string[];
}

/**
 * Shared Antigravity `groups[].buckets[]` quota-summary window reader (panel
 * quota types `AntigravityQuotaSummaryGroupPayload.buckets[]`: `window`,
 * `remainingFraction`, `resetTime`, `description`). Used by both the
 * subscription-answer parser (opportunistic groups) and the quota-summary
 * parser below, so the two answers shape windows identically. Identical
 * upstream window names repeating across groups are disambiguated rather than
 * emitted as duplicate ids (which would let one row overwrite or mask
 * another downstream). Per-window tolerance: one malformed bucket never
 * blinds the rest — it is skipped with a warning.
 */
function parseAntigravityBucketWindows(
  groups: unknown,
  observedAt: string | null,
  allowList: string[],
  warnings: string[],
): UsageLimitRow[] {
  const limits: UsageLimitRow[] = [];
  const list = Array.isArray(groups) ? groups : null;
  if (!list) return limits;
  const seenBucketWindows = new Map<string, number>();
  for (const g of list) {
    const group = asObj(g);
    if (!group) {
      warnings.push("antigravity: skipping a malformed quota group.");
      continue;
    }
    const buckets = Array.isArray(group.buckets) ? group.buckets : null;
    if (!buckets || buckets.length === 0) {
      warnings.push("antigravity: quota group has no buckets; treating this group as unknown.");
      continue;
    }
    for (const b of buckets) {
      const bucket = asObj(b);
      if (!bucket) {
        warnings.push("antigravity: skipping a malformed quota bucket.");
        continue;
      }
      const baseWindowName =
        getStr(bucket, "window", "window_name", "name", "id", "displayName", "display_name") ?? "window";
      const repeats = seenBucketWindows.get(baseWindowName) ?? 0;
      seenBucketWindows.set(baseWindowName, repeats + 1);
      const windowName = repeats === 0 ? baseWindowName : `${baseWindowName}#${repeats + 1}`;
      // `remainingFraction` is a 0–1 fraction, while a trailing `%` marks an
      // already-percent string (`"42%"` → 42, not 0.42).
      const remainingPercent = parseAntigravityRemainingPercent(
        bucket.remainingFraction ?? bucket.remaining_fraction ?? null,
      );
      if (remainingPercent === null) {
        warnings.push(`antigravity: bucket ${JSON.stringify(windowName)} has no usable percent; skipping.`);
        continue;
      }
      const usedPercent = 100 - remainingPercent;
      const exhausted = remainingPercent <= 0;
      limits.push(
        makeLimit({
          id: `antigravity:${windowName}`,
          label: getStr(bucket, "description", "displayName", "display_name") ?? `antigravity ${windowName}`,
          usedPercent,
          remainingPercent,
          resetsAt: toIsoTimestamp(bucket.resetTime ?? bucket.reset_time ?? null),
          limitReached: exhausted,
          allowed: exhausted ? false : true,
          gating: isGatingWindow("antigravity", baseWindowName, allowList),
          observedAt,
          viaProviderApi: true,
        }),
      );
    }
  }
  return limits;
}

/**
 * Does this `retrieveUserQuotaSummary` answer carry quota groups? The sync
 * loop's stop condition: the first 2xx quota answer WITH groups wins (and is
 * remembered); a 2xx without groups falls through to the next quota URL.
 * Tolerant by design — the parser below owns the detailed warnings.
 */
export function hasAntigravityQuotaGroups(body: unknown): boolean {
  if (typeof body === "string") {
    try {
      body = JSON.parse(body) as unknown;
    } catch {
      return false;
    }
  }
  const root = asObj(body);
  if (!root) return false;
  return Array.isArray(root.groups) && root.groups.length > 0;
}

/**
 * Parse an Antigravity `retrieveUserQuotaSummary` answer (panel
 * `src/features/quota/providers/antigravity/data.ts` `fetchQuotaPayload` +
 * `src/utils/quota/parsers.ts` `parseAntigravityPayload`): `groups[]` →
 * `buckets[]` with `remainingFraction` / `resetTime`, built into quota groups
 * by `buildAntigravityQuotaGroups`. Quota answers carry windows only, never
 * plan evidence — the plan comes from the subscription answer parsed
 * alongside. A valid answer without groups warns with zero windows (unknown,
 * never headroom).
 */
export function parseAntigravityQuota(
  body: unknown,
  observedAt: string | null,
  allowList: string[],
): ParsedApiQuota {
  const warnings: string[] = [];
  if (typeof body === "string") {
    try {
      body = JSON.parse(body) as unknown;
    } catch {
      warnings.push("antigravity: provider API quota answer is not JSON; treating this account as unknown.");
      return { planType: null, limits: [], warnings };
    }
  }
  const root = asObj(body);
  if (!root) {
    warnings.push("antigravity: provider API quota answer is not an object; treating this account as unknown.");
    return { planType: null, limits: [], warnings };
  }
  const limits = parseAntigravityBucketWindows(root.groups ?? null, observedAt, allowList, warnings);
  if (!Array.isArray(root.groups) || root.groups.length === 0) {
    warnings.push("antigravity: provider API quota answer carries no quota groups; treating this account as unknown.");
  }
  return { planType: null, limits, warnings };
}

/**
 * Tier id → plan word, copied from the panel's `PLAN_BY_TIER_ID` (panel
 * `src/services/api/antigravitySubscription.ts`). Unknown ids stay `unknown`,
 * never a guessed plan.
 */
const ANTIGRAVITY_PLAN_BY_TIER_ID: Record<string, string> = {
  "free-tier": "free",
  "g1-pro-tier": "pro",
  "g1-ultra-tier": "ultra",
  "g1-ultra-lite-tier": "ultra-lite",
};

function normalizeTier(value: unknown): { id: string | null; name: string | null } | null {
  const o = asObj(value);
  if (!o) return null;
  const id = getStr(o, "id");
  const name = getStr(o, "name");
  if (!id && !name) return null;
  return { id, name };
}

/**
 * Parse an Antigravity quota percent into 0–100 remaining. A trailing `%`
 * means the digits are already a percent (`"42%"` → 42); a bare number or a
 * string without `%` is a 0–1 fraction (`0.4` → 40). This distinction matters:
 * stripping `%` without remembering it turns `"1%"` into 100%.
 */
function parseAntigravityRemainingPercent(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value < 0 || value > 1.5) return null;
    const fraction = value > 1 ? value / 100 : value;
    return Math.max(0, Math.min(100, fraction * 100));
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  const isPercent = text.endsWith("%");
  const digits = (isPercent ? text.slice(0, -1) : text).trim();
  if (!digits || !Number.isFinite(Number(digits))) return null;
  const number = Number(digits);
  if (isPercent) {
    return number >= 0 && number <= 100 ? number : null;
  }
  if (number < 0 || number > 1.5) return null;
  const fraction = number > 1 ? number / 100 : number;
  return Math.max(0, Math.min(100, fraction * 100));
}

/**
 * Parse the Antigravity Code Assist subscription answer (panel
 * `src/services/api/antigravitySubscription.ts`
 * `parseAntigravitySubscriptionSummary`): `currentTier` / `paidTier` (snake
 * aliases tolerated) with the paid tier winning when it carries an id, mapped
 * through `PLAN_BY_TIER_ID`. The subscription call carries no quota windows
 * itself, so quota windows come only from an opportunistic `groups[].buckets[]`
 * quota-summary shape when the answer carries one (read by the shared bucket
 * helper above). Plan-only answers yield zero windows — the account stays
 * quota-blind on plan evidence alone, never headroom.
 */
export function parseAntigravitySubscription(
  body: unknown,
  observedAt: string | null,
  allowList: string[],
): ParsedApiQuota {
  const warnings: string[] = [];
  if (typeof body === "string") {
    try {
      body = JSON.parse(body) as unknown;
    } catch {
      warnings.push("antigravity: provider API answer is not JSON; treating this account as unknown.");
      return { planType: null, limits: [], warnings };
    }
  }
  const root = asObj(body);
  if (!root) {
    warnings.push("antigravity: provider API answer is not an object; treating this account as unknown.");
    return { planType: null, limits: [], warnings };
  }
  const currentTier = normalizeTier(root.currentTier ?? root.current_tier ?? null);
  const paidTier = normalizeTier(root.paidTier ?? root.paid_tier ?? null);
  const effective = paidTier?.id ? paidTier : currentTier;
  if (!effective?.id && !effective?.name) {
    warnings.push("antigravity: provider API answer names no tier; treating this account as unknown.");
    return { planType: null, limits: [], warnings };
  }
  const planWord =
    (effective.id && ANTIGRAVITY_PLAN_BY_TIER_ID[effective.id]) || "unknown";
  const planType = effective.name || planWord;

  // Opportunistic quota-summary groups on the same answer, read by the shared
  // bucket helper so subscription and quota answers shape windows identically.
  const limits = parseAntigravityBucketWindows(root.groups ?? null, observedAt, allowList, warnings);
  return { planType, limits, warnings };
}

/**
 * Strict panel-style percent (panel `devinQuota.ts` `parsePercent`): a finite
 * 0–100 number, or a digits-only string (`"75"`, never `"75%"`). Anything
 * else is unknown, never headroom.
 */
function parseDevinPercent(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
  }
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const percent = Number(value);
  return Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null;
}

/**
 * Strict panel-style unix-seconds instant (panel `devinQuota.ts`
 * `parseUnixSeconds`): a safe-integer seconds count (digits-only strings
 * accepted) to ISO. Anything else is null (no reset known).
 */
function parseDevinUnixSeconds(value: unknown): string | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) return null;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
  const iso = toIsoTimestamp(seconds);
  return iso;
}

/**
 * Parse the live Devin Connect-RPC `GetUserStatus` answer (panel
 * `src/features/quota/providers/devin/requests.ts`
 * `createDevinQuotaFetcher` via `readDevinQuotaResponse` in `devinQuota.ts`):
 * `userStatus.planStatus.{daily,weekly}QuotaRemainingPercent` (strict
 * digits-only) and `{daily,weekly}QuotaResetAtUnix` (unix seconds), plus
 * `planInfo.planName`. This reads the live RPC — never auth-file metadata or
 * `quota.signals` — which is why the connector saw nothing for Devin before
 * the live provider-API reads. An expected window without a usable percent is emitted as an
 * explicit unknown row: the row vetoes headroom (so a partial response
 * cannot leave a usable sibling as false headroom) but never reads as
 * exhaustion — a plan-only answer carries no quota evidence, so the account
 * stays unknown rather than waiting on a phantom limit. Zero usable windows
 * is `empty_data`-equivalent: plan only, account stays unknown.
 */
export function parseDevinQuota(
  body: unknown,
  observedAt: string | null,
  allowList: string[],
): ParsedApiQuota {
  const warnings: string[] = [];
  if (typeof body === "string") {
    try {
      body = JSON.parse(body) as unknown;
    } catch {
      warnings.push("devin: provider API answer is not JSON; treating this account as unknown.");
      return { planType: null, limits: [], warnings };
    }
  }
  const status = asObj(asObj(asObj(body)?.userStatus)?.planStatus);
  if (!status) {
    warnings.push("devin: provider API answer carries no userStatus.planStatus; treating this account as unknown.");
    return { planType: null, limits: [], warnings };
  }
  const planInfo = asObj(status.planInfo ?? null);
  const planName = planInfo ? getStr(planInfo, "planName", "plan_name") : null;
  const planType = (planName?.trim() || null) as string | null;
  const limits: UsageLimitRow[] = [];
  for (const window of ["daily", "weekly"] as const) {
    const remainingPercent = parseDevinPercent(status[`${window}QuotaRemainingPercent`]);
    if (remainingPercent === null) {
      warnings.push(`devin: ${window} quota percent is unusable; marking it unknown.`);
      limits.push(
        makeUnknownProviderWindow({
          provider: "devin",
          id: window,
          label: `devin ${window}`,
          observedAt,
          allowList,
          // The plan exists (planStatus answered) — admission is not denied,
          // only the percent telemetry is missing. `allowed: true` with a
          // null percent keeps the aggregation verdict unknown (still
          // vetoing headroom) instead of tripping Devin's admission-based
          // limiting rule into phantom exhaustion.
          allowed: true,
        }),
      );
      continue;
    }
    const usedPercent = 100 - remainingPercent;
    const exhausted = remainingPercent <= 0;
    limits.push(
      makeLimit({
        id: `devin:${window}`,
        label: `devin ${window}`,
        usedPercent,
        remainingPercent,
        resetsAt: parseDevinUnixSeconds(status[`${window}QuotaResetAtUnix`]),
        limitReached: exhausted,
        allowed: exhausted ? false : true,
        gating: isGatingWindow("devin", window, allowList),
        observedAt,
        viaProviderApi: true,
      }),
    );
  }
  if (limits.length === 0) {
    warnings.push("devin: provider API answer carries no usable quota windows; treating this account as unknown.");
  }
  return { planType, limits, warnings };
}

/**
 * Strict panel-style Meta percent (panel `metaQuota.ts` `parseUsedPercent`):
 * a finite 0–100 number, or a digits-only string — clamped, never guessed.
 * Anything else is null (unknown, never headroom).
 */
function parseMetaUsedPercent(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Math.min(100, Math.max(0, value));
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Math.min(100, Math.max(0, Number(value)));
  }
  return null;
}

/**
 * Strict panel-style unix-seconds instant (panel `metaQuota.ts`
 * `parsePositiveNumber` on `resets_at`): a positive finite seconds count
 * (digits-only strings accepted) to ISO. Anything else is null (no reset
 * known). Rejects non-positive values before `toIsoTimestamp`, which would
 * otherwise map small numbers to null anyway with a different story.
 */
function parseMetaResetAt(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return toIsoTimestamp(value);
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^\d+$/.test(text)) return null;
    const seconds = Number(text);
    if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
    return toIsoTimestamp(seconds);
  }
  return null;
}

/**
 * Parse the Meta `muse-code/key` answer (panel `src/services/api/metaQuota.ts`
 * `parseMetaQuotaPayload`): `subs_usage.window` / `subs_usage.weekly` with
 * `used_percent` and `resets_at`, plus the plan name from `subs_tier_name`
 * (falling back to `subs_usage.tier`) and the subscription flag. Only these
 * fields are read — the upstream answer may also carry `api_key` and PII, so
 * retaining the source object (or spreading it) is forbidden, exactly as in
 * the panel. A 2xx answer without `subs_usage` is a successful observation
 * with unknown quota (e.g. before the account's first request), not a zero
 * or a request error: both windows emit as explicit unknown rows that veto
 * headroom but never read as exhaustion. The `window_duration_mins` the
 * panel shows is display-only and carries no quota signal the rows need.
 */
export function parseMetaQuota(
  body: unknown,
  observedAt: string | null,
  allowList: string[],
): ParsedApiQuota {
  const warnings: string[] = [];
  if (typeof body === "string") {
    try {
      body = JSON.parse(body) as unknown;
    } catch {
      warnings.push("meta: provider API answer is not JSON; treating this account as unknown.");
      return { planType: null, limits: [], warnings };
    }
  }
  const root = asObj(body);
  if (!root) {
    warnings.push("meta: provider API answer is not an object; treating this account as unknown.");
    return { planType: null, limits: [], warnings };
  }
  const usage = asObj(root.subs_usage ?? null);
  const explicitPlan = typeof root.subs_tier_name === "string" ? root.subs_tier_name.trim() : "";
  const usagePlan = usage && typeof usage.tier === "string" ? usage.tier.trim() : "";
  const planType = (explicitPlan || usagePlan || null) as string | null;
  if (!usage) {
    warnings.push("meta: provider API answer carries no subs_usage; treating this account as unknown.");
  }
  const limits: UsageLimitRow[] = [];
  for (const window of ["window", "weekly"] as const) {
    const raw = usage ? asObj(usage[window] ?? null) : null;
    const usedPercent = raw ? parseMetaUsedPercent(raw.used_percent ?? null) : null;
    if (usedPercent === null) {
      if (usage && raw) {
        warnings.push(`meta: ${window} quota percent is unusable; marking it unknown.`);
      }
      limits.push(
        makeUnknownProviderWindow({
          provider: "meta",
          id: window,
          label: `meta ${window}`,
          observedAt,
          allowList,
          // The key endpoint answered — the subscription exists, only the
          // percent telemetry is missing. `allowed: true` with a null
          // percent keeps the aggregation verdict unknown (still vetoing
          // headroom) instead of tripping into phantom exhaustion.
          allowed: true,
        }),
      );
      continue;
    }
    const remainingPercent = 100 - usedPercent;
    const exhausted = remainingPercent <= 0;
    limits.push(
      makeLimit({
        id: `meta:${window}`,
        label: `meta ${window}`,
        usedPercent,
        remainingPercent,
        resetsAt: parseMetaResetAt(raw?.resets_at ?? null),
        limitReached: exhausted,
        allowed: exhausted ? false : true,
        gating: isGatingWindow("meta", window, allowList),
        observedAt,
        viaProviderApi: true,
      }),
    );
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
 * `allowed`, `limit-reached`). Devin daily/weekly windows are the primary
 * source for that provider and come from the auth-files passive observation
 * (`internal/auth/devin/record.go` writes them into `quotaSignals`, served
 * as `quota.signals` on the Devin entry):
 * `<daily|weekly>-quota-remaining-percent` (`"75%"`, trailing `%` stripped,
 * `used = 100 − remaining`), `<daily|weekly>-quota-reset-at` (RFC3339) and
 * `plan`. A bare `retry-after` (seconds) is an explicit
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
        // utilization): a nearly-unused account reads "1", never 100. Never
        // route through toUsedPercent. Overage readings up to 150 still
        // count — they mean exhausted, and dropping them would read unknown
        // instead of out.
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
    // Devin passive observation (primary source for daily/weekly — no Devin
    // plugin quota route serves these): `<daily|weekly>-quota-remaining-
    // percent` (`"75%"`, trailing `%` stripped via parseRemainingPercentField,
    // `used = 100 − remaining`), `<daily|weekly>-quota-reset-at` (RFC3339)
    // and `plan`. Unknown-provider stays tolerant so a Devin-shaped entry
    // filed under a future provider word still parses.
    if (provider === "devin" || provider === "unknown-provider") {
      const dm = /^(daily|weekly)-quota-(remaining-percent|reset-at)$/.exec(key);
      if (dm) {
        const a = acc(dm[1]!);
        if (dm[2] === "remaining-percent") {
          const remaining = parseRemainingPercentField(value);
          if (remaining !== null) a.used = Math.max(a.used ?? -Infinity, 100 - remaining);
          else ignored += 1;
        } else {
          const iso = toIsoTimestamp(value);
          if (iso) a.extraResetMs.push(Date.parse(iso));
          else ignored += 1;
        }
        continue;
      }
      if (key === "plan") {
        planType = value;
        continue;
      }
    }
    ignored += 1;
  }

  const limits: UsageLimitRow[] = [];
  for (const a of byWindow.values()) {
    // Metadata alone is never a window: a bare limit-name — or a lone
    // reset timestamp — with no quota reading must not emit an allowed:null
    // row, which reads as limiting for admission-signal providers and would
    // false-exhaust the account. A reset bound ships with the next real
    // reading; until then the window is unknown, never limiting.
    if (a.used === null && a.allowed === null && !a.limitReached) {
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
        // An explicit 429 watermark always gates, whatever the provider's
        // quota-window allow-list names: it is evidence of throttling (an
        // admission signal), not a quota window.
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
  /**
   * Credential `auth_index` from the `auth-files` list, or null when the
   * build does not report one. Sent as the single `?auth_index=` query value
   * on the per-file plugin-quota fetch (required since CLIProxy v8.0.49);
   * validated as a single safe value before any network happens.
   */
  authIndex: string | null;
  /**
   * Antigravity project id for the quota-summary api-call body
   * (`{"project": …}`), read from the auth-files entry: top-level, then
   * `metadata`, then `attributes` (panel field order, minus the auth-file
   * download the connector never performs). Null for non-Antigravity rows
   * and when the entry carries none. Raw string — the sync loop validates it
   * before any network happens.
   */
  quotaProjectId: string | null;
  /**
   * This entry's advertised plugin quota route (`quota_plugin_id`), or null
   * when it advertises none, opts out (`supports_quota: false`), or the id
   * is unusable. Lets same-provider accounts on different plugins each fetch
   * their own quota; the provider-level hint is only the fallback for rows
   * that advertise nothing.
   */
  quotaPluginId: string | null;
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
  /** Display-only blind reason (null when the account is not blind). */
  quotaBlindReason: string | null;
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
     * Legacy shape for builds whose entries carry no `auth_index`.
     */
    pluginPayloadByProvider?: Map<string, unknown>;
    /**
     * Raw plugin-quota payloads by credential `auth_index` (CLIProxy ≥ v8.0.49
     * per-file quota fetch). An account carrying an `auth_index` attaches
     * only its own file's payload; accounts without one fall back to the
     * legacy provider-level payload above, when present.
     */
    pluginPayloadByAuthIndex?: Map<string, unknown>;
    /**
     * Live provider-API subscription answers by credential `auth_index`
     * (pinned `POST /v0/management/api-call` templates: Antigravity
     * `loadCodeAssist`, Devin `GetUserStatus`). The parser selects the parser
     * by the account's own family — never by a caller-supplied key — and only
     * field-whitelisted quota shapes are kept. Non-2xx upstream answers warn
     * per file and stay quota-blind (fail open). Upstream 401/403 answers are
     * never attached here: the sync loop owns those (per-account backoff) and
     * warns once, so attaching them would double-warn.
     */
    apiCallPayloadByAuthIndex?: Map<string, { statusCode: number; body: unknown; observedAt?: string }>;
    /**
     * Live Antigravity quota-summary answers by credential `auth_index`
     * (pinned `retrieveUserQuotaSummary` templates, winning URL only). Parsed
     * by `parseAntigravityQuota` alongside the subscription answer above: the
     * subscription supplies plan evidence, the quota answer supplies windows.
     * Same non-2xx and 401/403 rules as the subscription answers.
     */
    apiCallQuotaPayloadByAuthIndex?: Map<string, { statusCode: number; body: unknown; observedAt?: string }>;
    /**
     * Fallback observation time for live provider-API windows that carry no
     * per-payload time: the sync's fetch time, never the passive `observed_at`.
     * Payloads from the sync loop always carry their own `observedAt` — fresh
     * fetches stamp sync time, throttled reuses stamp the original fetch —
     * so the staleness logic ages each answer honestly.
     */
    apiCallObservedAt?: string | null;
  },
): {
  accounts: ParsedAccount[];
  unkeyed: number;
  warnings: string[];
  /**
   * Per-provider plugin quota ids advertised by the entries themselves
   * (`quota_plugin_id`, unless `supports_quota: false`). First valid id wins
   * per provider; the operator config still wins over discovery. Only valid
   * single-segment ids are collected — anything else warns, never fetches.
   */
  pluginQuotaHints: Map<string, string>;
} {
  const warnings: string[] = [];
  const accounts: ParsedAccount[] = [];
  const pluginQuotaHints = new Map<string, string>();
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
    return { accounts, unkeyed, warnings, pluginQuotaHints };
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
    const authIndex = getAuthIndex(entry, "auth_index", "authIndex", "AuthIndex");
    // Project id for the Antigravity quota-summary call body. Same field
    // order the panel uses when it resolves a project id (list fields, then
    // metadata, then attributes) — but never the file download, which the
    // connector does not perform. Other families ignore it.
    const metadata = getObj(entry, "metadata", "Metadata");
    const attributes = getObj(entry, "attributes", "Attributes");
    const quotaProjectId =
      rawProvider === "antigravity"
        ? (getStr(entry, "project_id", "projectId", "virtual_project", "project") ??
          (metadata ? getStr(metadata, "project_id", "projectId", "virtual_project", "project") : null) ??
          (attributes
            ? getStr(attributes, "project_id", "projectId", "virtual_project", "project", "gemini_virtual_project")
            : null))
        : null;

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
    // Operator-free plugin quota discovery: an entry may advertise its own
    // plugin route (`quota_plugin_id`), unless it opts out with
    // `supports_quota: false`. Only keyed, enabled entries contribute —
    // unkeyed repeats and disabled credentials never drive fetches.
    // The validated per-entry id rides on the parsed row (see quotaPluginId):
    // same-provider accounts on different plugins each fetch their own quota
    // instead of all sharing the first-wins provider hint.
    let advertisedPluginId: string | null = null;
    if (!disabled) {
      const supportsQuota = entry.supports_quota ?? entry.supportsQuota ?? null;
      const hintedId = getStr(entry, "quota_plugin_id", "quotaPluginId");
      if (hintedId !== null && supportsQuota !== false) {
        if (SINGLE_SEGMENT.test(hintedId)) {
          advertisedPluginId = hintedId;
          const prior = pluginQuotaHints.get(provider);
          if (prior === undefined) pluginQuotaHints.set(provider, hintedId);
          else if (prior !== hintedId) {
            warnings.push(
              `${provider}: entries advertise conflicting quota plugin ids; using ${JSON.stringify(prior)}.`,
            );
          }
        } else {
          warnings.push(
            `${provider}: ignoring an unusable advertised quota plugin id; configure pluginQuotaIds explicitly.`,
          );
        }
      }
    }
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
    // Upstream text can carry account identifiers: never persist it raw.
    // Keep a short operational note with emails and long tokens stripped.
    const statusMessage = sanitizeStatusMessage(
      getStr(entry, "status_message", "statusMessage", "StatusMessage"),
    );
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
    // OpenRouter is display-only the same way until its plugin reports real
    // limits (its current no-limit bucket must never gate).
    const softGating = parserKey === "nvidia-nim" || parserKey === "openrouter";
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
      // CLIProxy always sends the `quota:{signals:{}}` shell for providers
      // other than claude, codex and devin: an empty shell with no
      // `observed_at` is expected, not a warning. A real observation (with
      // `observed_at`) that carries no signals still warns once.
      if (Object.keys(input.signals).length === 0 && input.observed !== null) {
        parseWarnings.push(`${provider}: account observation carries no quota signals; treating as unknown.`);
      }
      limits.push(...stampLimits(parsed.limits, input.observed, opts.now));
      if (!planType && parsed.planType) planType = parsed.planType;
    }

    // Per-file payloads win: an account carrying an `auth_index` attaches
    // only its own file's quota. Accounts without one (older builds) keep
    // the legacy provider-level payload. A failed per-file fetch attaches
    // nothing — it never falls back to a provider-wide fetch that would 400
    // on current builds.
    const pluginPayload =
      authIndex !== null
        ? opts.pluginPayloadByAuthIndex?.get(authIndex)
        : opts.pluginPayloadByProvider?.get(provider);
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

    // Live provider-API windows: the account's own api-call answers, parsed
    // by its own family's parser. A non-2xx upstream answer warns per file
    // and attaches nothing — fail open, never headroom.
    let apiLimits: UsageLimitRow[] = [];
    const apiPayload =
      authIndex !== null ? opts.apiCallPayloadByAuthIndex?.get(authIndex) : undefined;
    if (apiPayload !== undefined && !disabled) {
      const apiObservedAt = apiPayload.observedAt ?? opts.apiCallObservedAt ?? opts.now;
      if (apiPayload.statusCode < 200 || apiPayload.statusCode >= 300) {
        parseWarnings.push(
          `${provider}: provider API returned upstream HTTP ${apiPayload.statusCode}; treating this account as unknown for live quota.`,
        );
      } else {
        // Exact match on the raw provider word — never the fuzzy parser key:
        // a `gemini` answer must not parse as Antigravity quota (or vice
        // versa). The sync loop only fetches exact-word accounts, so this is
        // defense-in-depth for direct callers. Meta answers ride the
        // dedicated download + literal-header key call (no frozen template),
        // parsed by `parseMetaQuota`.
        const parsedApi: ParsedApiQuota | null =
          provider === "antigravity"
            ? parseAntigravitySubscription(apiPayload.body, apiObservedAt, allowList)
            : provider === "devin"
              ? parseDevinQuota(apiPayload.body, apiObservedAt, allowList)
              : provider === "meta"
                ? parseMetaQuota(apiPayload.body, apiObservedAt, allowList)
                : null;
        if (!parsedApi) {
          parseWarnings.push(
            `${provider}: provider API answer has no parser for this family; ignoring it.`,
          );
        } else {
          parseWarnings.push(...parsedApi.warnings);
          apiLimits = parsedApi.limits;
          // The live RPC is the freshest plan evidence: it wins when present.
          if (parsedApi.planType) planType = parsedApi.planType;
        }
      }
    }
    // Antigravity quota-summary windows: the winning `retrieveUserQuotaSummary`
    // answer, parsed alongside the subscription answer. The subscription gives
    // plan evidence, this gives windows; both append to the same live set.
    const apiQuotaPayload =
      authIndex !== null && provider === "antigravity"
        ? opts.apiCallQuotaPayloadByAuthIndex?.get(authIndex)
        : undefined;
    if (apiQuotaPayload !== undefined && !disabled) {
      const quotaObservedAt = apiQuotaPayload.observedAt ?? opts.apiCallObservedAt ?? opts.now;
      if (apiQuotaPayload.statusCode < 200 || apiQuotaPayload.statusCode >= 300) {
        parseWarnings.push(
          `${provider}: provider API quota returned upstream HTTP ${apiQuotaPayload.statusCode}; treating this account as unknown for live quota.`,
        );
      } else {
        const parsedQuota = parseAntigravityQuota(apiQuotaPayload.body, quotaObservedAt, allowList);
        parseWarnings.push(...parsedQuota.warnings);
        apiLimits = [...apiLimits, ...parsedQuota.limits];
      }
    } else if (!disabled && provider === "antigravity" && quotaProjectId === null) {
      // No quota call was possible: without a project id the connector cannot
      // shape the `{"project": …}` body, so only the subscription plan shows.
      parseWarnings.push(
        `${provider}: auth-files entry carries no project id; quota windows unavailable (plan evidence only).`,
      );
    }

    // Usable live windows supersede same-id passive/plugin windows: the RPC
    // reads the same underlying quota fresher (observed at sync time), and
    // keeping both would duplicate the row and let a stale passive reading
    // veto the fresh live headroom. An expected-but-unreadable live row must
    // not evict a usable twin: it joins the set only when no same-id
    // passive/plugin row covers the window, so a live answer without usable
    // percents degrades to unknown instead of discarding genuine headroom.
    // Failover stays: when the live fetch fails there is no apiLimit, so the
    // passive/plugin windows show again.
    // Twin scope is account-level only: passive rows from `model_quotas`
    // carry `models: [m]` while keeping the same account-level id
    // (`${provider}:${window}`). A model-scoped twin is per-model evidence —
    // possibly a stricter limit — so it neither covers an account-wide live
    // row nor is evicted by one.
    const usableLive = (l: UsageLimitRow) => l.remainingPercent !== null || l.limitReached;
    const accountLevel = (l: UsageLimitRow) => !l.models || l.models.length === 0;
    const liveIds = new Set(apiLimits.filter((l) => usableLive(l) && accountLevel(l)).map((l) => l.id));
    const live = (l: UsageLimitRow) => (accountLevel(l) ? !liveIds.has(l.id) : true);
    const twinIds = new Set(
      [...limits.filter(live), ...pluginLimits.filter(live)].filter(accountLevel).map((l) => l.id),
    );
    const apiRows = apiLimits.filter((l) => usableLive(l) || !twinIds.has(l.id));
    const stamped = softGating
      ? [...limits.filter(live).map((l) => ({ ...l, gating: false })), ...pluginLimits.filter(live), ...apiRows]
      : [...limits.filter(live), ...pluginLimits.filter(live), ...apiRows];

    // Antigravity publishes no passive signals: without live provider-API
    // windows it stays quota-blind. With at least one gating live window it
    // routes quota-aware like every other gated provider. Meta publishes no
    // passive signals either: without a live key answer it stays quota-blind
    // with the Meta reason above.
    const hasLiveGatingWindows = apiLimits.some((l) => l.gating);
    const quotaBlind =
      parserKey === "xai" ||
      parserKey === "kimi" ||
      parserKey === "compat" ||
      parserKey === "openrouter" ||
      parserKey === "unknown-provider" ||
      parserKey === "nvidia-nim" ||
      (parserKey === "meta" || parserKey === "antigravity"
        ? !hasLiveGatingWindows
        : stamped.length === 0 && pluginLimits.length === 0);

    if (quota && !observedAt) {
      parseWarnings.push(`${provider}: observation has no usable observed_at; using fetch time.`);
    }

    accounts.push({
      key,
      provider,
      channel,
      fileName,
      authIndex,
      quotaProjectId,
      quotaPluginId: advertisedPluginId,
      status,
      statusMessage,
      priority,
      limits: stamped,
      planType,
      quotaBlindReason: quotaBlind ? quotaBlindReason(parserKey, stamped.length > 0) : null,
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
      // Keep the parsed retry time even when it has passed: the aggregator
      // needs the past timestamp to tell "cooldown lifted, no fresh
      // telemetry" (unknown) apart from "no recovery bound at all" (out).
      // Nulling it here dead-coded that branch and re-waited forever.
      cooldownUntil: nextRetryAfter,
      parseWarnings: [...parseWarnings, ...(pluginQuota?.warnings ?? [])],
    });
  }
  return { accounts, unkeyed, warnings, pluginQuotaHints };
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
