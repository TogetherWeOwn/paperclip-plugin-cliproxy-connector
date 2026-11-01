/**
 * `usage_aware` router policy (TWO-679 v2, per-provider).
 *
 * Pure function over the plugin's own sync cache — the RPC handler never
 * calls CLIProxy inline (5 s budget). Each pool member resolves to a CLIProxy
 * provider through its binding `connectionId` → `providers[]` config row; the
 * requested model comes from the candidate's `runtimeConfig.model`, falling
 * back to the member `profile.model`. The per-(provider, model) verdict comes
 * from `aggregateProvider`:
 *
 * - `allowed` or `unknown` members are selectable (fail open);
 * - `exhausted` members are skipped with the aggregate's `retryAt`;
 * - a pool with nothing selectable returns `exhausted` with the earliest
 *   `retryAt` across the exhausted members, so core `ai_connection_wait`
 *   wakes the moment the first provider may have headroom again;
 * - pinned tasks never migrate: the pinned member alone is assessed under
 *   the same rule.
 *
 * Host contract (stated honestly, tested): `retryAt` is advisory — core owns
 * the actual wait and clamps it to its own bounds. The router returns member
 * selection plus `skipped` notes only; it never sees, forwards, or constrains
 * the task's native execution input. `missing-connection` drift is the
 * intended meaning: a `providers[]` row whose connection is bound by no pool
 * using this router (fleet-wide). It cannot be evaluated yet — the host's
 * route input carries only the current pool's candidates, so nothing computes
 * it across pools and nothing reports it as page drift today (see TWO-690 for
 * the sibling-pool membership gap). Per route, the only missing-connection
 * this pool can vouch for is its own member binding naming a connection with
 * no `providers[]` row; that is reported as a `skipped["pool:<id>"]` note.
 * Neither note ever blocks selection.
 *
 * Rotation (not most-headroom) orders the selectable members; unknown members
 * rotate with healthy ones (fail open), never ahead of them by design — order
 * is the host's `memberOrder` after `lastMemberId`, then members outside it.
 */

import { aggregateProvider, type ProviderAssessment } from "./aggregate.js";
import type { ConnectorConfig, ProviderEntry } from "./config.js";
import type { AccountUsageRow } from "./types.js";

export interface RouterCandidate {
  memberId: string;
  /** Requested model: candidate `runtimeConfig.model` ?? member `profile.model`. Empty when neither names one. */
  model: string;
  /** Pool member binding connection id when the binding carries one (may be null). */
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
  rows: AccountUsageRow[];
  config: ConnectorConfig;
}

export type RouteResult =
  | { kind: "selected"; memberId: string; skipped: Record<string, string> }
  | { kind: "exhausted"; retryAt: string; skipped: Record<string, string> }
  | { kind: "unavailable"; skipped: Record<string, string> };

function parseTime(v: string): number | null {
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** Resolve a candidate's binding connection to its `providers[]` row. Null when the binding names no (or no mapped) connection. */
export function resolveProviderRow(
  config: ConnectorConfig,
  connectionId: string | null,
): ProviderEntry | null {
  if (!connectionId) return null;
  return config.providers.find((p) => p.connectionId === connectionId) ?? null;
}

/**
 * `missing-connection` drift, fleet-wide: config rows whose connection id is
 * bound by none of the pools using this router. Pure.
 *
 * The caller MUST pass the union of member-binding connection ids across
 * every pool that routes through `cliproxy-connector` — never one pool's
 * members alone. The host's route input carries only the current pool's
 * candidates, so route() cannot satisfy that contract and never calls this
 * per route (a per-pool call false-positives on every sibling row in the
 * single-member-pool fleet). Evaluate it where the union is known (fleet
 * tests, a future host sibling-pool field, or an offline audit) and surface
 * findings as page drift; see TWO-690.
 */
export function detectMissingConnections(
  config: ConnectorConfig,
  pooledConnectionIds: Array<string | null>,
): ProviderEntry[] {
  const pooled = new Set(pooledConnectionIds.filter((c): c is string => !!c));
  return config.providers.filter((p) => !pooled.has(p.connectionId));
}

interface Assessment {
  candidate: RouterCandidate;
  provider: string | null;
  verdict: ProviderAssessment;
  /** Selectable: `allowed` or `unknown` (fail open). */
  eligible: boolean;
  /** Human reason; always non-empty for non-selected members. */
  reason: string;
}

function assess(candidate: RouterCandidate, input: RouteInput, rows: AccountUsageRow[]): Assessment {
  const row = resolveProviderRow(input.config, candidate.connectionId);
  if (!row) {
    const why = !candidate.connectionId
      ? `member binding names no connection; no providers[] row can vouch for it`
      : `member connection ${candidate.connectionId} matches no providers[] row`;
    return {
      candidate,
      provider: null,
      verdict: {
        provider: candidate.connectionId ?? "unmapped",
        model: candidate.model ? candidate.model.toLowerCase() : null,
        state: "unknown",
        retryAt: null,
        freshness: "missing",
        waitResumeOff: true,
        enabledAccounts: 0,
        headroomAccounts: 0,
        reason: `${why}; unknown (fail-open candidate, never headroom).`,
      },
      eligible: true,
      reason: `${why}; unknown (fail-open candidate).`,
    };
  }
  const verdict = aggregateProvider({
    provider: row.provider,
    model: candidate.model || null,
    rows,
    completeInventory: row.completeInventory,
    config: input.config,
    now: input.now,
    poolId: input.poolId,
    poolThresholdPercent: input.poolThresholdPercent,
  });
  return {
    candidate,
    provider: row.provider,
    verdict,
    eligible: verdict.state !== "exhausted",
    reason: verdict.reason,
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

function clampFuture(retryAt: string, nowMs: number): string {
  return retryAt <= new Date(nowMs + 1000).toISOString()
    ? new Date(nowMs + 1000).toISOString()
    : retryAt;
}

export function route(input: RouteInput): RouteResult {
  const nowMs = parseTime(input.now) ?? Date.now();
  // The only missing-connection this pool can vouch for is its own member
  // binding naming a connection with no `providers[]` row. Sibling rows
  // (present in config, bound by other pools) are never this pool's finding:
  // reporting them per route false-positives on every route in the
  // single-member-pool fleet (TWO-690). Fleet-wide absence (a row bound by
  // no pool at all) is `detectMissingConnections` over the union of every
  // pool's bindings — evaluated where that union is known, not here.
  const missingNote = (() => {
    const unmapped = [
      ...new Set(
        input.candidates
          .filter((c) => c.connectionId && !resolveProviderRow(input.config, c.connectionId))
          .map((c) => c.connectionId as string),
      ),
    ].sort();
    if (unmapped.length === 0) return null;
    return (
      `drift [missing-connection]: this pool binds connection(s) ${unmapped.join(", ")} ` +
      `with no providers[] row; the member routes unknown (fail open), never headroom. ` +
      `Add a providers[] row for the connection or fix the member binding.`
    );
  })();
  const withPoolNote = (skipped: Record<string, string>): Record<string, string> => {
    // An existing pool note (e.g. "no eligible candidates") describes this
    // decision; the drift note must never overwrite it.
    if (!missingNote || skipped[`pool:${input.poolId}`] !== undefined) return skipped;
    return { ...skipped, [`pool:${input.poolId}`]: missingNote };
  };

  if (input.poolMode !== "usage_aware") {
    const skipped: Record<string, string> = {};
    for (const c of input.candidates) {
      skipped[c.memberId] = `pool mode is ${JSON.stringify(input.poolMode)}; this router only serves usage_aware pools.`;
    }
    if (input.candidates.length === 0) {
      skipped[`pool:${input.poolId}`] = `pool mode is ${JSON.stringify(input.poolMode)}; this router only serves usage_aware pools.`;
    }
    return { kind: "unavailable", skipped: withPoolNote(skipped) };
  }
  if (input.candidates.length === 0) {
    return {
      kind: "unavailable",
      skipped: withPoolNote({
        [`pool:${input.poolId}`]: "the host offered no eligible candidates for this pool.",
      }),
    };
  }

  const assessed = input.candidates.map((c) => assess(c, input, input.rows));

  // Pinned tasks never migrate: decide on the pinned member alone, same rule.
  if (input.pinnedMemberId) {
    const pinned = assessed.find((a) => a.candidate.memberId === input.pinnedMemberId);
    if (!pinned) {
      return {
        kind: "unavailable",
        skipped: withPoolNote({
          [input.pinnedMemberId]: "task is pinned to a member the host did not offer; refusing to migrate.",
        }),
      };
    }
    if (!pinned.eligible) {
      const retryAt = clampFuture(
        pinned.verdict.retryAt ?? new Date(nowMs + input.config.recheckSeconds * 1000).toISOString(),
        nowMs,
      );
      return {
        kind: "exhausted",
        retryAt,
        skipped: withPoolNote({ [pinned.candidate.memberId]: `${pinned.reason} Retry at ${retryAt}.` }),
      };
    }
    // Allowed/unknown pinned members are selected even when dropped from memberOrder.
    return { kind: "selected", memberId: pinned.candidate.memberId, skipped: withPoolNote({}) };
  }

  const eligible = assessed.filter((a) => a.eligible);
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
      skipped[a.candidate.memberId] =
        a.eligible && a.verdict.state === "unknown"
          ? `${a.reason} Not this turn (rotation).`
          : a.reason;
    }
    return { kind: "selected", memberId: selectedId, skipped: withPoolNote(skipped) };
  }

  // Nothing selectable: every assessment is `exhausted` (unmappable candidates
  // are unknown, hence eligible). The pool wakes at the earliest aggregate
  // retryAt — the first provider that may have headroom again. Each aggregate
  // always carries a retryAt (recheck fallback), so core wait/resume always
  // gets a bound.
  const future = assessed
    .map((a) => (a.verdict.retryAt ? parseTime(a.verdict.retryAt) : null))
    .filter((t): t is number => t !== null && t > nowMs);
  const retryAt = clampFuture(
    future.length > 0
      ? new Date(Math.min(...future)).toISOString()
      : new Date(nowMs + input.config.recheckSeconds * 1000).toISOString(),
    nowMs,
  );
  const skipped: Record<string, string> = {};
  for (const a of assessed) {
    skipped[a.candidate.memberId] = `${a.reason} Retry at ${retryAt}.`;
  }
  return { kind: "exhausted", retryAt, skipped: withPoolNote(skipped) };
}
