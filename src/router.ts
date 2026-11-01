/**
 * `usage_aware` router policy (proposal §3, TWO-579 defaults comparison).
 *
 * Pure function over the plugin's own sync cache — the RPC handler never
 * calls CLIProxy inline (5 s budget). Decisions:
 *
 * - Align with upstream #17007: 10% reserve default (strict `>`, min across
 *   gating windows); pinned tasks never migrate with pinned-wait using the
 *   **latest limiting** reset; identity check per quota row; per-provider
 *   gating-window allow-list; 60 s recheck for unknown/stale; rotation (not
 *   most-headroom) among above-reserve members; never an empty `skipped`
 *   reason.
 * - Deliberately differ: reserve is per-pool config (not hard-coded);
 *   freshness is sync-relative (≥2× sync interval); stale telemetry is
 *   **bounded** fail-open (within a grace window, only to
 *   last-known-above-reserve members — then fail closed to `exhausted`);
 *   `allowed: null` waits only for providers exposing an admission signal;
 *   no near-reset exception in v1.
 */

import { effectiveReservePercent, graceMs, maxAgeMs, type ConnectorConfig } from "./config.js";
import { hasAdmissionSignal, normalizeProvider } from "./parsers.js";
import type { AccountUsageRow, Freshness } from "./types.js";

export interface RouterCandidate {
  memberId: string;
  /** Pool member `profile.model`, e.g. `acct-claude-2/claude-sonnet-5`. */
  model: string;
  /** Binding connection id when the binding carries one (may be null). */
  connectionId: string | null;
}

export interface RouteInput {
  now: string;
  poolId: string;
  poolMode: string;
  poolThresholdPercent?: unknown;
  memberOrder: string[];
  lastMemberId: string | null;
  pinnedMemberId?: string | null;
  candidates: RouterCandidate[];
  rows: Map<string, AccountUsageRow>;
  config: ConnectorConfig;
}

export type RouteResult =
  | { kind: "selected"; memberId: string; skipped: Record<string, string> }
  | { kind: "exhausted"; retryAt: string; skipped: Record<string, string> }
  | { kind: "unavailable"; skipped: Record<string, string> };

/** First path segment of a pinned member model, or null when unpinned. */
export function prefixOfModel(model: string): string | null {
  const slash = model.indexOf("/");
  if (slash <= 0) return null;
  const prefix = model.slice(0, slash);
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(prefix) ? prefix : null;
}

interface Assessment {
  candidate: RouterCandidate;
  prefix: string | null;
  row: AccountUsageRow | null;
  trusted: boolean;
  trustReason: string;
  freshness: Freshness;
  ageMs: number | null;
  /** Known-healthy (above reserve) under a trusted fresh/stale observation. */
  healthy: boolean;
  /** Known-exhausted/low under a trusted observation or cooldown. */
  low: boolean;
  /** Limiting reset timestamps (ISO) behind a `low` verdict. */
  limitingResets: string[];
  /** Human reason; always non-empty for non-selected members. */
  reason: string;
}

function parseTime(v: string): number | null {
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

function assess(
  candidate: RouterCandidate,
  input: RouteInput,
  nowMs: number,
  reserve: number,
  maxAge: number,
  grace: number,
  futureSkewMs: number,
): Assessment {
  const prefix = prefixOfModel(candidate.model);
  const row = prefix ? (input.rows.get(prefix) ?? null) : null;

  if (!prefix) {
    // Unpinned members can never be keyed to a quota row, so there is nothing
    // to fail open on: exclude them from eligibility (`low: true`) so the pool
    // exhausts with a reason instead of selecting an unaccounted member.
    return {
      candidate, prefix, row, trusted: false,
      trustReason: `member model ${JSON.stringify(candidate.model)} is not a pinned <prefix>/<model> id; skipping (pinning required).`,
      freshness: "missing", ageMs: null, healthy: false, low: true, limitingResets: [],
      reason: `member model ${JSON.stringify(candidate.model)} is not a pinned <prefix>/<model> id; skipping (pinning required).`,
    };
  }
  if (!row) {
    return {
      candidate, prefix, row, trusted: false,
      trustReason: `no synced quota for prefix ${prefix}; treating as unknown.`,
      freshness: "missing", ageMs: null, healthy: false, low: false, limitingResets: [],
      reason: `no synced quota for prefix ${prefix}; unknown (fail-open candidate).`,
    };
  }

  // Identity check (TWO-579): the row must belong to the mapped connection,
  // and the candidate binding must agree when it names a connection.
  const mapped = input.config.prefixMap[prefix];
  let trusted = true;
  let trustReason = `quota row for ${prefix} verified against the operator map.`;
  if (mapped === undefined) {
    trusted = false;
    trustReason = `prefix ${prefix} is not in the operator map (drift); quota row is untrusted.`;
  } else if (row.connectionId === null || row.connectionId !== mapped) {
    trusted = false;
    trustReason = `quota row for ${prefix} names connection ${row.connectionId ?? "none"}, map says ${mapped}; untrusted.`;
  } else if (candidate.connectionId !== null && candidate.connectionId !== row.connectionId) {
    trusted = false;
    trustReason = `member binding names connection ${candidate.connectionId}, quota row belongs to ${row.connectionId}; untrusted.`;
  }

  const { freshness, ageMs } = classifyFreshness(row.checkedAt, nowMs, maxAge, grace, futureSkewMs);

  if (!trusted || freshness === "missing" || freshness === "expired") {
    if (freshness === "expired" && trusted) {
      return {
        candidate, prefix, row, trusted, trustReason, freshness, ageMs,
        healthy: false, low: true,
        limitingResets: [],
        reason: `telemetry for ${prefix} is beyond the grace window; failing closed for this member.`,
      };
    }
    const why = !trusted
      ? trustReason
      : `telemetry for ${prefix} is missing or from the future; treating as unknown.`;
    return {
      candidate, prefix, row, trusted, trustReason, freshness, ageMs,
      healthy: false, low: false,
      limitingResets: [],
      reason: `${why} Unknown (fail-open candidate).`,
    };
  }

  // Trusted + fresh/stale observation.
  if (row.coolingDown) {
    const until = row.cooldownUntil && parseTime(row.cooldownUntil) !== null ? row.cooldownUntil : null;
    return {
      candidate, prefix, row, trusted, trustReason, freshness, ageMs,
      healthy: false, low: true,
      limitingResets: until ? [until] : [],
      reason: `CLIProxy reports a 429/cooldown state for ${prefix}${until ? ` until ${until}` : ""}; waiting.`,
    };
  }

  const gating = row.limits.filter((l) => l.gating);
  if (gating.length === 0) {
    // Quota-blind provider (unknown path): eligible within the grace window,
    // never claiming headroom. Admission-`null` cannot wait here because there
    // is no admission signal at all (TWO-579 capability rule).
    return {
      candidate, prefix, row, trusted, trustReason, freshness, ageMs,
      healthy: false, low: false, limitingResets: [],
      reason: `${prefix} is quota-blind (${row.provider || "unknown provider"} exposes no gating windows); unknown (fail-open candidate).`,
    };
  }

  const admission = hasAdmissionSignal(normalizeProvider(row.provider));
  // Strict `>`: a window exactly at the reserve is limiting (TWO-579).
  const limiting: string[] = [];
  for (const w of gating) {
    if (w.allowed === false || w.limitReached) {
      limiting.push(w.id);
      continue;
    }
    if (w.allowed === null && admission) {
      // Providers with an admission signal: `null` waits (copy #17007).
      limiting.push(w.id);
      continue;
    }
    if (w.remainingPercent !== null) {
      if (w.remainingPercent <= reserve) limiting.push(w.id);
    } else {
      // Gating window with no percent and no admission verdict: unknown.
      limiting.push(`${w.id} (no percent)`);
    }
  }

  if (limiting.length > 0) {
    const resets = gating
      .filter((w) => limiting.some((id) => id === w.id || id.startsWith(`${w.id} `)))
      .map((w) => w.resetsAt)
      .filter((r): r is string => r !== null && parseTime(r) !== null);
    return {
      candidate, prefix, row, trusted, trustReason, freshness, ageMs,
      healthy: false, low: true, limitingResets: resets,
      reason: `${prefix} is at or below the ${reserve}% reserve on ${limiting.join(", ")}; waiting.`,
    };
  }
  return {
    candidate, prefix, row, trusted, trustReason, freshness, ageMs,
    healthy: true, low: false, limitingResets: [],
    reason: `${prefix} is above the ${reserve}% reserve on every gating window.`,
  };
}

/** Rotation order: memberOrder after lastMemberId, then members outside it. */
function rotationOrder(memberOrder: string[], lastMemberId: string | null, ids: string[]): string[] {
  const inOrder = ids.filter((id) => memberOrder.includes(id));
  const outside = ids.filter((id) => !memberOrder.includes(id));
  if (inOrder.length === 0) return [...ids];
  const ordered = [...memberOrder.filter((id) => inOrder.includes(id))];
  if (lastMemberId) {
    const idx = ordered.indexOf(lastMemberId);
    if (idx >= 0) {
      const rotated = [...ordered.slice(idx + 1), ...ordered.slice(0, idx + 1)];
      return [...rotated, ...outside];
    }
  }
  return [...ordered, ...outside];
}

export function route(input: RouteInput): RouteResult {
  const nowMs = parseTime(input.now) ?? Date.now();
  const reserve = effectiveReservePercent(input.config, {
    id: input.poolId,
    thresholdPercent: input.poolThresholdPercent,
  });
  const maxAge = maxAgeMs(input.config);
  const grace = graceMs(input.config);
  const futureSkewMs = input.config.futureSkewSeconds * 1000;
  const recheckAt = new Date(nowMs + input.config.recheckSeconds * 1000).toISOString();

  if (input.poolMode !== "usage_aware") {
    const skipped: Record<string, string> = {};
    for (const c of input.candidates) {
      skipped[c.memberId] = `pool mode is ${JSON.stringify(input.poolMode)}; this router only serves usage_aware pools.`;
    }
    if (input.candidates.length === 0) {
      skipped[`pool:${input.poolId}`] = `pool mode is ${JSON.stringify(input.poolMode)}; this router only serves usage_aware pools.`;
    }
    return { kind: "unavailable", skipped };
  }
  if (input.candidates.length === 0) {
    return {
      kind: "unavailable",
      skipped: { [`pool:${input.poolId}`]: "the host offered no eligible candidates for this pool." },
    };
  }

  const assessed = input.candidates.map((c) => assess(c, input, nowMs, reserve, maxAge, grace, futureSkewMs));

  // Pinned tasks never migrate: decide on the pinned member alone.
  if (input.pinnedMemberId) {
    const pinned = assessed.find((a) => a.candidate.memberId === input.pinnedMemberId);
    if (!pinned) {
      return {
        kind: "unavailable",
        skipped: {
          [input.pinnedMemberId]: "task is pinned to a member the host did not offer; refusing to migrate.",
        },
      };
    }
    if (pinned.low) {
      // Greptile P2 lesson: a pinned wait uses the LATEST limiting reset.
      const resets = pinned.limitingResets
        .map((r) => parseTime(r) ?? -Infinity)
        .filter((t) => t > nowMs);
      const retryAt =
        resets.length > 0
          ? new Date(Math.max(...resets)).toISOString()
          : recheckAt;
      return {
        kind: "exhausted",
        retryAt: retryAt <= new Date(nowMs + 1000).toISOString() ? new Date(nowMs + 1000).toISOString() : retryAt,
        skipped: { [pinned.candidate.memberId]: pinned.reason },
      };
    }
    // Healthy pinned members are selected even when dropped from memberOrder.
    return { kind: "selected", memberId: pinned.candidate.memberId, skipped: {} };
  }

  const eligible = assessed.filter((a) => a.healthy || isFailOpen(a));
  const orderedIds = rotationOrder(
    input.memberOrder,
    input.lastMemberId,
    eligible.map((a) => a.candidate.memberId),
  );
  if (orderedIds.length > 0) {
    const selectedId = orderedIds[0] as string;
    const skipped: Record<string, string> = {};
    for (const a of assessed) {
      if (a.candidate.memberId === selectedId) continue;
      skipped[a.candidate.memberId] = a.low || !isFailOpen(a) ? a.reason : `${a.reason} Not this turn (rotation).`;
    }
    return { kind: "selected", memberId: selectedId, skipped };
  }

  // Nothing eligible: exhausted. Pooled wait uses the earliest known reset;
  // unknown/stale-only pools recheck in 60 s.
  const resets: number[] = [];
  for (const a of assessed) {
    for (const r of a.limitingResets) {
      const t = parseTime(r);
      if (t !== null && t > nowMs) resets.push(t);
    }
  }
  let retryAt = resets.length > 0 ? new Date(Math.min(...resets)).toISOString() : recheckAt;
  if (retryAt <= new Date(nowMs + 1000).toISOString()) {
    retryAt = new Date(nowMs + 1000).toISOString();
  }
  const skipped: Record<string, string> = {};
  for (const a of assessed) {
    skipped[a.candidate.memberId] = a.reason;
  }
  return { kind: "exhausted", retryAt, skipped };
}

/** Fail-open eligible: not known-exhausted (unknown, or healthy). */
function isFailOpen(a: Assessment): boolean {
  if (a.low) return false;
  if (!a.trusted) return true;
  if (a.freshness === "expired") return false;
  return true;
}
