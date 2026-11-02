/**
 * Per-provider request-count aggregation for `GET /v0/management/api-key-usage`.
 *
 * The endpoint answers `{[provider]: {[compositeKey]: {success, failed,
 * recent_requests}}}` where each composite key is `base_url|api_key` — raw
 * provider key material that must never enter plugin state, UI payloads, logs
 * or tests (threat T1). This module aggregates in the worker and drops the
 * composite keys at the parse boundary: the returned shape has no key field,
 * only provider-level totals, so downstream code structurally cannot leak a
 * key it never receives.
 *
 * Fidelity limits (surfaced on the usage page, never silently upgraded):
 * - request counts only — the endpoint reports no tokens and no per-model
 *   split, so no token figures are synthesized here;
 * - `api_key` auths only: OAuth lanes are invisible to this endpoint and are
 *   labelled as such on the page.
 */

import type { ProviderRequestCounts, RequestBucket } from "./types.js";

export class RequestCountsBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestCountsBodyError";
  }
}

/** A finite, non-negative count; anything else reads as 0 (unknown, never headroom). */
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * Validate one recent-request bucket. The `time` label is server-generated
 * (a bucket label, not free text); it is length-bounded and must be a string.
 * Non-conforming buckets are dropped (counted for the caller's warning).
 */
function bucket(value: unknown): { bucket: RequestBucket | null; dropped: boolean } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { bucket: null, dropped: true };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.time !== "string" || !record.time || record.time.length > 64) {
    return { bucket: null, dropped: true };
  }
  return {
    bucket: { time: record.time, success: count(record.success), failed: count(record.failed) },
    dropped: false,
  };
}

/**
 * Merge per-key bucket series by time label (summing success/failed), so the
 * page shows one recent-window trend per provider. Labels sort lexically —
 * the endpoint emits fixed-width labels, so lexical order is chronological.
 */
function mergeBuckets(series: RequestBucket[][]): RequestBucket[] {
  const merged = new Map<string, RequestBucket>();
  for (const buckets of series) {
    for (const b of buckets) {
      const at = merged.get(b.time);
      if (at) {
        at.success += b.success;
        at.failed += b.failed;
      } else {
        merged.set(b.time, { ...b });
      }
    }
  }
  return [...merged.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, b]) => b);
}

/**
 * Aggregate the raw `api-key-usage` payload by provider. Composite keys are
 * iterated for their values only and never copied to the output; the returned
 * rows carry provider words, counts and bucket labels — no key material.
 * Unknown provider words normalize to `unknown` (CLIProxy's own fallback).
 * Non-object payloads and non-object provider entries reject; malformed key
 * entries are skipped with a warning count.
 */
export function parseApiKeyUsage(
  raw: unknown,
  fetchedAt: string,
): { lanes: ProviderRequestCounts[]; warnings: string[] } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new RequestCountsBodyError("api-key-usage payload is not an object.");
  }
  const lanes: ProviderRequestCounts[] = [];
  const warnings: string[] = [];
  for (const [providerRaw, entriesRaw] of Object.entries(raw as Record<string, unknown>)) {
    const provider = providerRaw.trim().toLowerCase() || "unknown";
    if (typeof entriesRaw !== "object" || entriesRaw === null || Array.isArray(entriesRaw)) {
      warnings.push(`${provider}: api-key-usage provider entry is not an object; skipping.`);
      continue;
    }
    let success = 0;
    let failed = 0;
    let skipped = 0;
    let droppedBuckets = 0;
    const series: RequestBucket[][] = [];
    // Composite `base_url|api_key` keys are deliberately never read: only the
    // per-key counters are summed. The key strings never leave this loop.
    for (const entryRaw of Object.values(entriesRaw as Record<string, unknown>)) {
      if (typeof entryRaw !== "object" || entryRaw === null || Array.isArray(entryRaw)) {
        skipped += 1;
        continue;
      }
      const entry = entryRaw as Record<string, unknown>;
      success += count(entry.success);
      failed += count(entry.failed);
      const recent = entry.recent_requests ?? entry.recentRequests;
      if (recent === undefined) continue;
      if (!Array.isArray(recent)) {
        droppedBuckets += 1;
        continue;
      }
      const buckets: RequestBucket[] = [];
      for (const item of recent) {
        const { bucket: parsed, dropped } = bucket(item);
        if (parsed) buckets.push(parsed);
        else droppedBuckets += 1;
      }
      if (buckets.length > 0) series.push(buckets);
    }
    if (skipped > 0) {
      warnings.push(`${provider}: skipped ${skipped} malformed api-key-usage key entr${skipped === 1 ? "y" : "ies"}.`);
    }
    if (droppedBuckets > 0) {
      warnings.push(`${provider}: dropped ${droppedBuckets} malformed recent-request bucket${droppedBuckets === 1 ? "" : "s"}.`);
    }
    lanes.push({
      provider,
      success,
      failed,
      total: success + failed,
      recent: mergeBuckets(series),
      fetchedAt,
    });
  }
  lanes.sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0));
  return { lanes, warnings };
}
