/**
 * Plugin page + dashboard widget data (proposal §3 UI).
 *
 * Served worker-side via `ctx.data` (`page`, `widget`); the React bundle in
 * `ui/` renders it. Everything here is derived from the plugin's own cache —
 * never upstream account identity beyond the operator-chosen display labels
 * and opaque hashes.
 *
 * Audience (proposal §4 point 4): this page shows upstream account identity
 * (provider, plan labels, per-account quota state). The operator confirms
 * which company roles may view plugin pages via `audienceConfirmed` before
 * relying on this page; until then the audience notice below stays on screen.
 */

import { graceMs, maxAgeMs, type ConnectorConfig } from "./config.js";
import { strikeWaitUntil } from "./sync.js";
import type { AccountUsageRow, DriftFinding, StrikeBudgetState, SyncFailure, SyncSummary } from "./types.js";

export const AUDIENCE_NOTICE =
  "Audience: this page shows upstream AI account identity (providers, plan labels, per-account quota state). " +
  "Confirm which company roles may view plugin pages and that this exposure is intended (proposal §4 point 4), " +
  "then set audienceConfirmed: true in the company config.";

export interface AccountCardLimit {
  id: string;
  label: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
  resetIn: string | null;
  limitReached: boolean;
  allowed: boolean | null;
  gating: boolean;
  stale: boolean;
}

export interface AccountCard {
  prefix: string;
  connectionId: string | null;
  mapped: boolean;
  provider: string;
  planType: string | null;
  quotaBlind: boolean;
  freshness: "fresh" | "stale" | "expired" | "missing";
  checkedAt: string;
  limits: AccountCardLimit[];
  lastError: string | null;
  coolingDown: boolean;
  cooldownUntil: string | null;
  /** Copy-paste-ready connection snippet for the operator runbook. */
  connectionSnippet: string;
  /** Suggested member profile.model for the pool member. */
  suggestedProfileModel: string;
}

export interface PageData {
  audienceNotice: string;
  audienceConfirmed: boolean;
  generatedAt: string;
  sync: {
    ranAt: string | null;
    accountsSeen: number;
    rowsWritten: number;
    skipped: boolean;
    skipReason: string | null;
    errors: string[];
    /** Latest failed attempt (own state key; never moves `ranAt`). Null when the last attempt succeeded. */
    lastError: string | null;
    lastAttemptAt: string | null;
  };
  strike: {
    disabled: boolean;
    disabledAt: string | null;
    disabledReason: string | null;
    secretBad: boolean;
    recentFailures: string[];
    /**
     * ISO time when the next probe is allowed again (the rolling 30 min
     * window has room). Null when probing is currently allowed. The page
     * renders this as "wait until <time>" instead of offering a probe that
     * would push the host past 2 rejections per 30 min.
     */
    waitUntil: string | null;
  };
  drift: DriftFinding[];
  accounts: AccountCard[];
  earliestReset: string | null;
}

export interface WidgetData {
  generatedAt: string;
  ok: boolean;
  status: string;
  accounts: number;
  quotaBlind: number;
  driftCount: number;
  earliestReset: string | null;
  earliestResetIn: string | null;
  staleCount: number;
}

export function resetIn(resetAt: string | null, nowMs: number): string | null {
  if (!resetAt) return null;
  const t = Date.parse(resetAt);
  if (Number.isNaN(t)) return null;
  const diff = t - nowMs;
  if (diff <= 0) return "now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function suggestedProtocol(provider: string): "messages" | "responses" {
  switch (provider) {
    case "codex":
    case "xai":
    case "devin":
      return "responses";
    default:
      return "messages";
  }
}

export function buildConnectionSnippet(prefix: string, provider: string, baseUrl: string): string {
  const protocol = suggestedProtocol(provider);
  return JSON.stringify(
    {
      method: "api_key",
      routing: {
        kind: "local",
        protocol,
        baseUrl,
        auth: "bearer",
        models: [`${prefix}/<model-id-as-listed>`],
      },
      note: "credential = a CLIProxy client key, never upstream material",
    },
    null,
    2,
  );
}

export function buildPageData(args: {
  now: string;
  config: ConnectorConfig;
  rows: Record<string, AccountUsageRow>;
  lastSync: SyncSummary | null;
  strike: StrikeBudgetState;
  lastFailure?: SyncFailure | null;
}): PageData {
  const { now, config, rows, lastSync, strike, lastFailure } = args;
  const nowMs = Date.parse(now);
  const maxAge = maxAgeMs(config);
  const grace = graceMs(config);

  const accounts: AccountCard[] = Object.values(rows)
    .sort((a, b) => a.prefix.localeCompare(b.prefix))
    .map((row) => {
      const at = Date.parse(row.checkedAt);
      const age = Number.isNaN(at) ? Infinity : nowMs - Math.min(at, nowMs);
      const freshness =
        !Number.isFinite(age) || age < 0 ? "missing" : age <= maxAge ? "fresh" : age <= grace ? "stale" : "expired";
      const stale = freshness !== "fresh";
      return {
        prefix: row.prefix,
        connectionId: row.connectionId,
        mapped: row.connectionId !== null,
        provider: row.provider,
        planType: row.planType,
        quotaBlind: row.quotaBlind,
        freshness,
        checkedAt: row.checkedAt,
        limits: row.limits.map((l) => ({
          id: l.id,
          label: l.label,
          usedPercent: l.usedPercent,
          remainingPercent: l.remainingPercent,
          resetsAt: l.resetsAt,
          resetIn: resetIn(l.resetsAt, nowMs),
          limitReached: l.limitReached,
          allowed: l.allowed,
          gating: l.gating,
          stale,
        })),
        lastError: row.lastError,
        coolingDown: row.coolingDown,
        cooldownUntil: row.cooldownUntil,
        connectionSnippet: buildConnectionSnippet(row.prefix, row.provider, config.cliproxyBaseUrl),
        suggestedProfileModel: `${row.prefix}/<model-id-as-listed>`,
      };
    });

  const resets = accounts
    .flatMap((a) => a.limits.map((l) => l.resetsAt))
    .filter((r): r is string => r !== null && !Number.isNaN(Date.parse(r)));
  const earliestReset =
    resets.length > 0 ? new Date(Math.min(...resets.map((r) => Date.parse(r)))).toISOString() : null;

  return {
    audienceNotice: AUDIENCE_NOTICE,
    audienceConfirmed: config.audienceConfirmed,
    generatedAt: now,
    sync: {
      ranAt: lastSync?.finishedAt ?? null,
      accountsSeen: lastSync?.accountsSeen ?? 0,
      rowsWritten: lastSync?.rowsWritten ?? 0,
      skipped: lastSync?.skipped ?? true,
      skipReason: lastSync?.skipReason ?? "no sync has run yet.",
      errors: lastSync?.errors ?? [],
      // A failure newer than the last successful run is shown explicitly so
      // the page never silently presents stale success as current state. An
      // older failure stays recorded but shows neither message nor attempt
      // time next to the newer success.
      lastError:
        lastFailure &&
        (!lastSync ||
          Number.isNaN(Date.parse(lastSync.finishedAt)) ||
          Date.parse(lastFailure.attemptedAt) > Date.parse(lastSync.finishedAt))
          ? lastFailure.message
          : null,
      lastAttemptAt:
        lastFailure &&
        (!lastSync ||
          Number.isNaN(Date.parse(lastSync.finishedAt)) ||
          Date.parse(lastFailure.attemptedAt) > Date.parse(lastSync.finishedAt))
          ? lastFailure.attemptedAt
          : null,
    },
    strike: {
      disabled: strike.disabled,
      disabledAt: strike.disabledAt,
      disabledReason: strike.disabledReason,
      secretBad: strike.secretBad,
      recentFailures: strike.failures,
      waitUntil: strikeWaitUntil(strike.failures, nowMs),
    },
    drift: lastSync?.drift ?? [],
    accounts,
    earliestReset,
  };
}

export function buildWidgetData(args: {
  now: string;
  config: ConnectorConfig;
  rows: Record<string, AccountUsageRow>;
  lastSync: SyncSummary | null;
  strike: StrikeBudgetState;
  lastFailure?: SyncFailure | null;
}): WidgetData {
  const page = buildPageData(args);
  const nowMs = Date.parse(args.now);
  const staleCount = page.accounts.filter((a) => a.freshness === "stale" || a.freshness === "expired").length;
  const status = args.strike.disabled
    ? "disabled (strike budget spent)"
    : page.sync.lastError
      ? `last sync failed: ${page.sync.lastError}`
      : page.drift.length > 0
        ? `${page.drift.length} drift finding${page.drift.length === 1 ? "" : "s"}`
        : page.accounts.length === 0
          ? "no accounts synced yet"
          : "healthy";
  return {
    generatedAt: args.now,
    ok: !args.strike.disabled,
    status,
    accounts: page.accounts.length,
    quotaBlind: page.accounts.filter((a) => a.quotaBlind).length,
    driftCount: page.drift.length,
    earliestReset: page.earliestReset,
    earliestResetIn: resetIn(page.earliestReset, nowMs),
    staleCount,
  };
}
