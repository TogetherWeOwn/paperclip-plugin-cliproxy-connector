/**
 * Sync job (cron 2–5 min + on-demand): CLIProxy → plugin cache.
 *
 * Reads the CLIProxy account list + per-provider quota through the proposal
 * §4 safe path (GET-only allow-list, `api-call` excluded) and normalises into
 * `AiConnectionUsage`-shaped rows in the plugin's own namespace.
 *
 * Security properties (all tested):
 * - the management key is resolved per run and kept in memory only;
 * - first 401/403 stops the run immediately and marks the secret bad with a
 *   board-visible setup error;
 * - ≤2 auth failures per rolling 30 min hard-disables sync until an explicit
 *   board re-enable — a config edit never resets the budget (the budget lives
 *   in plugin state under its own key, untouched by config changes);
 * - single-flight + minimum interval between runs.
 */

import { CliproxyAuthError, CliproxyManagementClient, type ManagementFetch } from "./cliproxy.js";
import type { ConnectorConfig } from "./config.js";
import { parseAuthFiles, type ParsedAccount } from "./parsers.js";
import type {
  AccountUsageRow,
  DriftFinding,
  StrikeBudgetState,
  SyncFailure,
  SyncSummary,
} from "./types.js";

export const STRIKE_WINDOW_MS = 30 * 60_000;
export const STRIKE_LIMIT = 2;
export const MIN_SYNC_INTERVAL_MS = 60_000;

export function emptyStrikeBudget(): StrikeBudgetState {
  return { failures: [], disabled: false, disabledAt: null, disabledReason: null, secretBad: false };
}

export function pruneFailures(failures: string[], nowMs: number): string[] {
  return failures.filter((iso) => {
    const t = Date.parse(iso);
    return !Number.isNaN(t) && t > nowMs - STRIKE_WINDOW_MS;
  });
}

/**
 * When the next probe is allowed again: the moment the failure count drops
 * below STRIKE_LIMIT. Null when the window already has room. The board page
 * shows this as "wait until <time>" instead of offering a probe that would
 * trip the host-wide CLIProxy ban.
 */
export function strikeWaitUntil(failures: string[], nowMs: number): string | null {
  const pruned = pruneFailures(failures, nowMs)
    .map((iso) => Date.parse(iso))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);
  if (pruned.length < STRIKE_LIMIT) return null;
  return new Date(pruned[pruned.length - STRIKE_LIMIT] + STRIKE_WINDOW_MS).toISOString();
}

export interface SyncDeps {
  config: ConnectorConfig;
  companyId: string;
  now: string;
  /** Resolve the management key from the secret_ref. Per run, memory only. */
  resolveSecret: (ref: unknown) => Promise<string>;
  fetchImpl?: ManagementFetch;
  loadStrike: () => Promise<StrikeBudgetState>;
  saveStrike: (s: StrikeBudgetState) => Promise<void>;
  loadRows: () => Promise<Record<string, AccountUsageRow>>;
  loadLastSync: () => Promise<SyncSummary | null>;
  saveSync: (rows: Record<string, AccountUsageRow>, summary: SyncSummary) => Promise<void>;
  /**
   * Persist (or clear, with null) the latest sync failure under its own key.
   * Never touches `last-sync.finishedAt`, which drives the min-interval
   * check — a failed attempt must neither look like a success nor delay the
   * next retry.
   */
  recordFailure: (failure: SyncFailure | null) => Promise<void>;
  logActivity: (message: string, metadata?: Record<string, unknown>) => Promise<void>;
}

function summary(
  startedAt: string,
  finishedAt: string,
  partial: Partial<SyncSummary> & { skipped: boolean; skipReason: string | null },
): SyncSummary {
  return {
    accountsSeen: 0,
    rowsWritten: 0,
    drift: [],
    errors: [],
    ...partial,
    startedAt,
    finishedAt,
  };
}

export async function runSync(deps: SyncDeps, inFlight: { running: boolean }): Promise<SyncSummary> {
  const startedAt = deps.now;
  const nowMs = Date.parse(deps.now);
  const finish = (partial: Partial<SyncSummary> & { skipped: boolean; skipReason: string | null }) =>
    summary(startedAt, new Date().toISOString(), partial);

  if (inFlight.running) {
    return finish({ skipped: true, skipReason: "previous sync still running (single-flight)." });
  }
  inFlight.running = true;
  try {
    const strike = await deps.loadStrike();
    if (strike.disabled) {
      return finish({
        skipped: true,
        skipReason:
          `sync hard-disabled since ${strike.disabledAt ?? "unknown time"}: ${strike.disabledReason ?? "strike budget spent"}. ` +
          "Board re-enable required; config edits do not reset the budget.",
      });
    }
    // The window is full (only possible right after a board re-enable that
    // kept the rolling failures): refuse to probe. Sending a key that is
    // still bad here would push the host past 2 rejections in 30 min.
    // Re-disable with the wait time so the page says "wait until <time>".
    {
      const kept = pruneFailures(strike.failures, nowMs);
      const waitUntil = strikeWaitUntil(kept, nowMs);
      if (waitUntil) {
        const reason =
          `strike budget still full (${kept.length}/${STRIKE_LIMIT} auth failures in 30 min); ` +
          `wait until ${waitUntil} before probing again. No probe was sent.`;
        await deps.saveStrike({
          ...strike,
          failures: kept,
          disabled: true,
          disabledAt: new Date(nowMs).toISOString(),
          disabledReason: reason,
        });
        return finish({
          skipped: true,
          skipReason: `${reason} Board re-enable required; config edits do not reset the budget.`,
        });
      }
    }
    // A rejected key is never probed again automatically: only an explicit
    // board re-enable (ideally together with a rotated secret) clears this.
    if (strike.secretBad) {
      return finish({
        skipped: true,
        skipReason:
          "CLIProxy previously rejected the management key; sync is paused and no probe was sent. " +
          "Rotate the key and re-enable from the plugin page (board action).",
      });
    }
    const last = await deps.loadLastSync();
    if (last && !Number.isNaN(Date.parse(last.finishedAt))) {
      const gap = nowMs - Date.parse(last.finishedAt);
      if (gap < MIN_SYNC_INTERVAL_MS) {
        return finish({ skipped: true, skipReason: `minimum sync interval not reached (${Math.ceil((MIN_SYNC_INTERVAL_MS - gap) / 1000)}s left).` });
      }
    }

    let key: string;
    try {
      key = await deps.resolveSecret(deps.config.managementSecretRef);
    } catch (err) {
      const message = `could not resolve the CLIProxy management secret: ${err instanceof Error ? err.message : "unknown error"}`;
      await deps.recordFailure({ attemptedAt: startedAt, message });
      await deps.logActivity(`cliproxy-connector: ${message}`, { companyId: deps.companyId });
      return finish({ skipped: true, skipReason: message, errors: [message] });
    }
    if (!key) {
      const message = "CLIProxy management secret resolved empty; refusing to probe without a key.";
      await deps.recordFailure({ attemptedAt: startedAt, message });
      await deps.logActivity(`cliproxy-connector: ${message}`, { companyId: deps.companyId });
      return finish({ skipped: true, skipReason: message, errors: [message] });
    }

    const client = new CliproxyManagementClient({
      baseUrl: deps.config.cliproxyBaseUrl,
      keyHeader: deps.config.managementKeyHeader,
      key,
      fetchImpl: deps.fetchImpl,
    });
    // `key` must not survive this function: the client is dropped on every
    // exit path below, and nothing persists it (redaction tests prove it).
    // (`key = ""` in the finally below only clears this local binding; the
    // client's copy is an immutable string left for GC — no copies are made.)
    try {
      const authFiles = await client.getAuthFiles().catch((err) => {
        throw err;
      });

      // Per-plugin quota fetch is best-effort: a failing plugin route leaves
      // the account on its passive signals (or unknown), never headroom.
      // Raw payloads ride along by prefix; parseAuthFiles parses each with
      // its owning account's provider + allow-list.
      const pluginPayloadByPrefix = new Map<string, unknown>();
      const pluginErrors: string[] = [];
      for (const [prefix, pluginId] of Object.entries(deps.config.pluginQuotaIds)) {
        try {
          pluginPayloadByPrefix.set(prefix, await client.getPluginQuota(pluginId));
        } catch (err) {
          if (err instanceof CliproxyAuthError) throw err; // stop after first rejected key
          pluginErrors.push(`${prefix} (plugin ${pluginId}): ${err instanceof Error ? err.message : "fetch failed"}`);
        }
      }

      const { accounts, unkeyed, warnings } = parseAuthFiles(authFiles, {
        now: deps.now,
        allowLists: deps.config.providerWindows,
        pluginPayloadByPrefix,
      });

      // Group by prefix: duplicates defeat pinning (spike G-K1) and alarm loudly.
      const byPrefix = new Map<string, typeof accounts>();
      for (const a of accounts) {
        const list = byPrefix.get(a.prefix) ?? [];
        list.push(a);
        byPrefix.set(a.prefix, list);
      }

      const { rows, drift } = accountsToRows(byPrefix, unkeyed, deps.config.prefixMap);

      const errors = [...pluginErrors, ...warnings];
      for (const d of drift) {
        await deps.logActivity(`cliproxy-connector drift [${d.kind}] ${d.prefix}: ${d.detail}`, {
          companyId: deps.companyId,
        });
      }
      const result = finish({
        skipped: false,
        skipReason: null,
        accountsSeen: accounts.length,
        rowsWritten: Object.keys(rows).length,
        drift,
        errors,
      });
      await deps.saveSync(rows, result);
      // A success clears the last failure so the page stops showing it.
      await deps.recordFailure(null);
      return result;
    } catch (err) {
      if (err instanceof CliproxyAuthError) {
        return await recordAuthFailure(deps, strike, nowMs, finish, err, startedAt);
      }
      // Non-auth failures (CLIProxy down, schema errors, …) never reached
      // last-sync and were never logged: the page kept showing the last
      // successful run. Record the failure under its own key (leaving
      // `finishedAt` — and the min-interval check — untouched) and log it.
      const message = `sync failed: ${err instanceof Error ? err.message : "unknown error"}`;
      await deps.recordFailure({ attemptedAt: startedAt, message });
      await deps.logActivity(`cliproxy-connector: ${message}`, { companyId: deps.companyId });
      return finish({ skipped: true, skipReason: message, errors: [message] });
    } finally {
      // Drop the only in-memory reference to resolved key material.
      key = "";
    }
  } finally {
    inFlight.running = false;
  }
}

/**
 * Turn parsed accounts (grouped by prefix) into cache rows + drift findings.
 * Exported so route-level regression tests run the real sync mapping instead
 * of hand-built rows.
 */
export function accountsToRows(
  byPrefix: Map<string, ParsedAccount[]>,
  unkeyed: number,
  prefixMap: Record<string, string>,
): { rows: Record<string, AccountUsageRow>; drift: DriftFinding[] } {
  const rows: Record<string, AccountUsageRow> = {};
  const drift: DriftFinding[] = [];
  for (const [prefix, list] of byPrefix) {
    if (list.length > 1) {
      drift.push({
        kind: "duplicate-prefix",
        prefix,
        detail: `${list.length} CLIProxy accounts share prefix ${prefix}; pinning is ambiguous. Keeping the first row only — give every account a unique prefix.`,
      });
    }
    const first = list[0] as ParsedAccount;
    rows[prefix] = {
      prefix,
      connectionId: prefixMap[prefix] ?? null,
      provider: first.provider,
      poolFamily: "unknown",
      limits: first.limits,
      planType: first.planType,
      checkedAt: first.checkedAt,
      source: "plugin:cliproxy-connector",
      quotaBlind: first.quotaBlind,
      accountHash: first.accountHash,
      lastError: first.parseWarnings.length > 0 ? first.parseWarnings.join(" | ") : null,
      coolingDown: first.coolingDown,
      cooldownUntil: first.cooldownUntil,
    };
    if (prefixMap[prefix] === undefined) {
      drift.push({
        kind: "unmapped-account",
        prefix,
        detail: `CLIProxy account ${prefix} (${first.channel}) has no prefix → connectionId mapping; the router cannot trust its quota.`,
      });
    }
  }
  if (unkeyed > 0) {
    drift.push({
      kind: "unkeyed-observation",
      prefix: "(unkeyed)",
      detail: `${unkeyed} auth-files entr${unkeyed === 1 ? "y has" : "ies have"} no single-segment prefix and cannot be keyed to the map; their quota is ignored.`,
    });
  }
  for (const prefix of Object.keys(prefixMap)) {
    if (!byPrefix.has(prefix)) {
      drift.push({
        kind: "mapped-but-missing",
        prefix,
        detail: `map points ${prefix} at a connection, but CLIProxy reports no such account; the router decides on missing telemetry for this member.`,
      });
    }
  }
  return { rows, drift };
}

async function recordAuthFailure(
  deps: SyncDeps,
  strike: StrikeBudgetState,
  nowMs: number,
  finish: (p: Partial<SyncSummary> & { skipped: boolean; skipReason: string | null }) => SyncSummary,
  err: CliproxyAuthError,
  startedAt: string,
): Promise<SyncSummary> {
  const failures = pruneFailures([...strike.failures, new Date(nowMs).toISOString()], nowMs);
  const overBudget = failures.length >= STRIKE_LIMIT;
  const next: StrikeBudgetState = {
    failures,
    disabled: overBudget,
    disabledAt: overBudget ? new Date(nowMs).toISOString() : strike.disabledAt,
    disabledReason: overBudget
      ? `CLIProxy rejected the management key ${failures.length}× in 30 min (HTTP ${err.status}); sync hard-disabled. Rotate the key and re-enable from the plugin page.`
      : strike.disabledReason,
    secretBad: true,
  };
  await deps.saveStrike(next);
  const setupError = overBudget
    ? (next.disabledReason as string)
    : `CLIProxy rejected the management key (HTTP ${err.status}); secret marked bad (${failures.length}/${STRIKE_LIMIT} strikes). Next rejection hard-disables sync until board re-enable.`;
  // Auth failures are already surfaced via the strike block, but the page's
  // sync section should name the latest failure too (same key, same rule:
  // `last-sync.finishedAt` stays untouched).
  await deps.recordFailure({ attemptedAt: startedAt, message: setupError });
  await deps.logActivity(`cliproxy-connector setup error: ${setupError}`, { companyId: deps.companyId });
  return finish({ skipped: true, skipReason: setupError, errors: [setupError] });
}

/**
 * Explicit board re-enable after a spent strike budget. This is the ONLY
 * path that clears `disabled`/`secretBad` — config edits never do, and the
 * sync job never probes while `secretBad` is set.
 *
 * The rolling `failures` are KEPT (pruned to the window): CLIProxy's own
 * 30 min counter does not reset when the board clicks re-enable, so a key
 * that is still bad must not get a fresh budget. When the kept window is
 * still full, the budget stays spent with a wait-until time and no probe is
 * ever sent; once the window has room, probing resumes (one strike left).
 */
export async function reenableAfterStrike(
  loadStrike: () => Promise<StrikeBudgetState>,
  saveStrike: (s: StrikeBudgetState) => Promise<void>,
  nowIso: string = new Date().toISOString(),
): Promise<StrikeBudgetState> {
  const strike = await loadStrike();
  const nowMs = Date.parse(nowIso);
  const kept = pruneFailures(strike.failures, Number.isNaN(nowMs) ? Date.now() : nowMs);
  const waitUntil = strikeWaitUntil(kept, Number.isNaN(nowMs) ? Date.now() : nowMs);
  const next: StrikeBudgetState = waitUntil
    ? {
        failures: kept,
        disabled: true,
        disabledAt: nowIso,
        disabledReason:
          `strike budget still full (${kept.length}/${STRIKE_LIMIT} auth failures in 30 min); ` +
          `wait until ${waitUntil} before probing again. No probe was sent.`,
        secretBad: false,
      }
    : {
        failures: kept,
        disabled: false,
        disabledAt: null,
        disabledReason: null,
        secretBad: false,
      };
  await saveStrike(next);
  return next;
}
