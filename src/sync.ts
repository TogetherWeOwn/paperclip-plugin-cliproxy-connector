/**
 * Sync job (cron 2–5 min + on-demand): CLIProxy → plugin cache.
 *
 * Reads the CLIProxy account list + per-provider quota through the proposal
 * §4 safe path (pinned GET allow-list plus the pinned `api-call` POST
 * templates for Antigravity/Devin — one subscription call per account per
 * sync, plus one winning quota-summary call for Antigravity accounts that
 * carry a project id — and the dedicated Meta download + literal-header key
 * call, at most every 45 minutes per account plus manual refresh), groups
 * accounts by provider, and normalises into `AiConnectionUsage`-shaped rows
 * in the plugin's own namespace. No core changes, no fork.
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

import {
  apiCallQuotaTemplateKeysForProvider,
  apiCallTemplateKeyForProvider,
  CliproxyAuthError,
  CliproxyClientApiClient,
  CliproxyConfigError,
  CliproxyManagementClient,
  CliproxyNotFoundError,
  isSafeApiCallProjectId,
  readDcaTokenFromAuthFile,
  type ManagementFetch,
} from "./cliproxy.js";
import {
  AUTH_FILE_REF_PREFIX,
  isLiveQuotaEnabled,
  isMetaQuotaEnabled,
  type ConnectorConfig,
  type ProviderEntry,
} from "./config.js";
import {
  deriveProviderModels,
  observedModelKeysByProvider,
  parseModelsPayload,
  type ServedModel,
} from "./models.js";
import { fetchOpenRouterCredits, type OpenRouterFetch } from "./openrouter.js";
import {
  hasAntigravityQuotaGroups,
  hashIdentity,
  parseAuthFiles,
  sanitizeStatusMessage,
  type ParsedAccount,
} from "./parsers.js";
import { parseApiKeyUsage } from "./request-counts.js";
import type {
  AccountUsageRow,
  DriftFinding,
  DriftLedger,
  DriftLedgerEntry,
  ModelOverlap,
  StoredRequestCounts,
  StoredSpend,
  StrikeBudgetState,
  SyncFailure,
  SyncSummary,
} from "./types.js";

/**
 * Stable activity keys. The host stores the plugin `message` verbatim in the
 * activity `action` column, so the message is a short stable key and the human
 * sentence rides in `metadata.summary` with structured fields alongside.
 */
export const ACTIVITY_DRIFT_DETECTED = "cliproxy_connector.drift_detected";
export const ACTIVITY_DRIFT_CLEARED = "cliproxy_connector.drift_cleared";
export const ACTIVITY_DRIFT_STILL_PRESENT = "cliproxy_connector.drift_still_present";
export const ACTIVITY_SYNC_FAILED = "cliproxy_connector.sync_failed";
export const ACTIVITY_SYNC_RECOVERED = "cliproxy_connector.sync_recovered";
export const ACTIVITY_SETUP_ERROR = "cliproxy_connector.setup_error";
export const ACTIVITY_STRIKE_BUDGET_REENABLED = "cliproxy_connector.strike_budget_reenabled";

/**
 * At most one reminder row per drift finding (or per persisting failure) per
 * 24 h while it stays present. New findings, cleared findings, new failure
 * signatures and recoveries always log exactly once.
 */
export const ACTIVITY_REMINDER_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * Stable ledger key for a drift finding: `kind + provider + detail`. Details
 * are count-free and stable, so the key survives across syncs until the
 * finding genuinely appears or disappears.
 */
export function driftKeyFor(finding: Pick<DriftFinding, "kind" | "provider" | "detail">): string {
  return `${finding.kind}:${finding.provider}:${finding.detail}`;
}

export const STRIKE_WINDOW_MS = 30 * 60_000;
export const STRIKE_LIMIT = 2;
export const MIN_SYNC_INTERVAL_MS = 60_000;
/**
 * Minimum gap between two credential-bearing provider-API call rounds for the
 * same CLIProxy origin + credential (`auth_index`). The scheduled sync runs
 * every 5 minutes, so a 4-minute bound keeps at most one subscription round
 * per account per sync even when the on-demand resync action fires back to
 * back — repeated provider hits with stored credentials could otherwise get
 * those accounts flagged — while a 1-minute jitter tolerance keeps a slightly
 * early cron tick from blanking the live windows on alternate runs. An
 * Antigravity account whose round runs also makes its quota-summary call(s)
 * in the same round (remembered winning URL first, so usually one extra call).
 */
export const API_CALL_MIN_INTERVAL_MS = 4 * 60_000;

/**
 * Per-account backoff after an UPSTREAM 401/403 (not a management-key
 * rejection — that keeps the strike-budget path): epoch millis until which
 * the origin + credential is skipped without any provider call. One hour
 * bounds a bad endpoint to ~24 attempts/day instead of ~288, while a fixed
 * worker-owned map (never persisted) means a restart or resync re-verifies
 * immediately instead of inheriting a stale ban.
 */
export const API_CALL_AUTH_BACKOFF_MS = 60 * 60_000;

/**
 * Minimum gap between two Meta live-quota reads (download + key call) for
 * the same CLIProxy origin + credential. The panel only reads this endpoint
 * on user refresh, never on a poll loop — the connector polls it at most
 * every 45 minutes per account (mid-point of the required 30–60 minute
 * band) with the last 2xx answer cached and reused between polls, plus an
 * explicit manual refresh. The scheduled 5-minute cadence serves the cache
 * on every run in between, so steady state costs ~32 Meta reads per
 * account per day, not ~288.
 */
export const META_QUOTA_MIN_INTERVAL_MS = 45 * 60_000;

/**
 * Cache-namespace key for the Meta Muse-key answer inside the shared
 * `apiCallCache` map (`${accountKey} ${META_API_CACHE_KEY}`). Meta has no
 * frozen template, so it cannot reuse a template key — this constant keeps
 * the Meta envelope in its own bucket.
 */
export const META_API_CACHE_KEY = "meta-muse-code-key";

/**
 * Last known-good live provider-API answer per CLIProxy origin + credential
 * `auth_index`. Only 2xx envelopes are kept, in memory only, never persisted
 * or logged — same as the throttle timestamps.
 */
export interface ApiCallCachedEnvelope {
  statusCode: number;
  body: unknown;
  /** The sync time the cached answer was fetched (its windows keep this age). */
  observedAt: string;
}

/**
 * Normalise a CLIProxy base URL to its origin for api-call throttle/cache
 * keying. Two companies pointing at the same CLIProxy share one throttle
 * bucket and one cache entry per credential; different origins never share.
 * The `localhost` spelling is normalised exactly the way the transport
 * canonicalises it, so `localhost` and `127.0.0.1` configurations of one
 * CLIProxy do not throttle (and call) twice.
 */
export function apiCallOriginKey(cliproxyBaseUrl: string): string {
  try {
    const url = new URL(cliproxyBaseUrl);
    if (url.hostname.toLowerCase() === "localhost") url.hostname = "127.0.0.1";
    return url.origin;
  } catch {
    return cliproxyBaseUrl.trim();
  }
}

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
  /**
   * Resolve the client (non-management) API key from its secret_ref, for
   * `GET /v1/models` only. Per run, memory only, same as the management key.
   */
  resolveClientSecret: (ref: unknown) => Promise<string>;
  /**
   * Host outbound fetch for the OpenRouter credits read. Omitted in unit
   * tests that do not cover spend (the read is skipped without it, exactly
   * like a missing secret ref). The worker passes `ctx.http.fetch`.
   */
  httpFetch?: OpenRouterFetch;
  fetchImpl?: ManagementFetch;
  /** Last-known spend snapshot + soft note (own state key, never quota rows). */
  loadSpend: () => Promise<StoredSpend | null>;
  saveSpend: (s: StoredSpend) => Promise<void>;
  /** Last-known request-count aggregates + soft note (own state key). */
  loadRequestCounts: () => Promise<StoredRequestCounts | null>;
  saveRequestCounts: (s: StoredRequestCounts) => Promise<void>;
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
  /** Latest recorded sync failure, for failure dedupe and recovery logging. */
  loadFailure: () => Promise<SyncFailure | null>;
  /**
   * Drift ledger for state-change activity logging. Null when no ledger was
   * ever persisted (pre-upgrade state): the first successful sync seeds it
   * silently instead of emitting a burst for pre-existing findings.
   */
  loadDriftLedger: () => Promise<DriftLedger | null>;
  saveDriftLedger: (ledger: DriftLedger) => Promise<void>;
  logActivity: (message: string, metadata?: Record<string, unknown>) => Promise<void>;
  /**
   * Last provider-API call time per CLIProxy origin + credential `auth_index`
   * (epoch millis), keyed `${apiCallOriginKey(baseUrl)} ${authIndex}`. The
   * worker owns one shared map across runs and companies; callers that omit it
   * get no cross-run throttling. Tests pass their own map to assert the bound.
   */
  apiCallLastCall?: Map<string, number>;
  /**
   * Last 2xx provider-API answer per CLIProxy origin + credential `auth_index`
   * + template key (`${apiCallOriginKey(baseUrl)} ${authIndex} ${templateKey}` —
   * the subscription answer and each quota answer cache separately). A
   * throttled run reuses the cached envelopes — stamped with their original
   * `observedAt` — instead of blanking the account's live windows. In memory
   * only, never persisted or logged.
   */
  apiCallCache?: Map<string, ApiCallCachedEnvelope>;
  /**
   * Per-account upstream-auth backoff: `${apiCallOriginKey(baseUrl)} ${authIndex}`
   * → epoch millis until which the account is skipped without any provider
   * call, after an upstream 401/403. The worker owns one shared map across
   * runs and companies; callers that omit it get no backoff (every sync
   * retries). Expired entries are dropped on encounter. Tests pass their own
   * map to assert the bound.
   */
  apiCallAuthBackoffUntil?: Map<string, number>;
  /**
   * Remembered working Antigravity quota template per CLIProxy origin +
   * credential `auth_index`. The quota loop tries the remembered key first and
   * overwrites it whenever a different quota URL wins, so steady state costs
   * one quota call per account per sync. In memory only, never persisted.
   */
  apiCallQuotaChoice?: Map<string, string>;
  /**
   * Manual-refresh bypass for the Meta quota throttle only (the board resync
   * action sets it): a forced run re-reads every Meta account even inside
   * `META_QUOTA_MIN_INTERVAL_MS`. Scheduled runs leave it unset and serve
   * the cache between polls. The upstream-auth backoff is never bypassed — a
   * backed-off account still waits out its hour.
   */
  forceMetaRefresh?: boolean;
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
    acceptedDrift: [],
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
      await logSyncFailure(deps, { kind: "secret-unresolvable", message });
      return finish({ skipped: true, skipReason: message, errors: [message] });
    }
    if (!key) {
      const message = "CLIProxy management secret resolved empty; refusing to probe without a key.";
      await logSyncFailure(deps, { kind: "secret-empty", message });
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
      // Prefer the v8 credential list (v8-only renewal fields feed the
      // read-only "needs sign-in" badge); older builds 404 and fall back to
      // the v0 `auth-files` list. The parse is shape-tolerant to both.
      const { payload: authFiles, source: listSource } = await client.getAuthFilesWithV8Fallback().catch((err) => {
        throw err;
      });

      // Discovery is credential-scoped: no sibling route may supply missing
      // capability evidence. Explicit operator mappings take precedence over
      // each account's validated advertised ID. v8 requires an auth_index;
      // retain only the explicitly configured v0 no-index compatibility path.
      const pluginPayloadByAccountKey = new Map<string, unknown>();
      const pluginErrors: string[] = [];
      const pluginResults = new Map<string, unknown>();
      const attemptedPluginKeys = new Set<string>();
      const discovered = parseAuthFiles(authFiles, {
        now: deps.now,
        allowLists: deps.config.providerWindows,
        showAccountEmails: deps.config.showAccountEmails === true,
      });
      const configuredPluginProviders = new Set(deps.config.providers.map((p) => p.provider));
      for (const a of discovered.accounts) {
        if (a.status === "disabled" || !configuredPluginProviders.has(a.provider)) continue;
        const override = deps.config.pluginQuotaIds[a.provider];
        const pluginId = override ?? a.quotaPluginId;
        if (!pluginId) continue;
        if (!a.authIndex && (listSource === "v8" || !override)) {
          pluginErrors.push(`${a.provider}: quota discovery has no credential index; plugin quota remains unknown.`);
          continue;
        }
        const fetchKey = JSON.stringify([pluginId, a.authIndex]);
        if (!attemptedPluginKeys.has(fetchKey)) {
          // Failed routes are deduplicated too: one attempt per route/index
          // per sync, never another management-auth probe after rejection.
          attemptedPluginKeys.add(fetchKey);
          try {
            pluginResults.set(fetchKey, await client.getPluginQuota(pluginId, a.authIndex));
          } catch (err) {
            if (err instanceof CliproxyAuthError) throw err;
            const fileRef = `auth ${hashIdentity([a.authIndex ?? a.key])?.slice(0, 8) ?? "unknown"}`;
            const rawMessage = err instanceof Error ? err.message : "fetch failed";
            const safeMessage = a.authIndex ? rawMessage.split(a.authIndex).join(fileRef) : rawMessage;
            pluginErrors.push(`${a.provider} (plugin ${pluginId}, ${fileRef}): ${safeMessage}`);
          }
        }
        if (pluginResults.has(fetchKey)) {
          pluginPayloadByAccountKey.set(a.key, pluginResults.get(fetchKey));
        }
      }

      // Live provider-API quota: pinned `POST /v0/management/api-call`
      // calls for the enabled, configured antigravity/devin accounts — the
      // families with templates — plus the dedicated Meta download + key
      // call per Meta account (auth-file download, `dca_token` extraction,
      // literal-header `muse-code/key`; see the block below). The template
      // comes from an exact allow-map on the auth file's raw provider word,
      // never from fuzzy matching: a `gemini` account must not send its
      // credential through the Antigravity request. Disabled accounts are
      // never called; cooling accounts keep their cooldown (no probe while
      // the provider says wait); one subscription round per index per sync
      // bounds the rate to the sync cadence (every 5 min), and the
      // per-credential throttle below holds that bound across back-to-back
      // resyncs. Meta polls at most every 45 minutes per account (plus
      // manual refresh) with the last 2xx answer cached between polls.
      // Antigravity accounts with a project id add a quota-summary round
      // (remembered winning URL first, so usually one extra call). Raw
      // envelopes ride along by `auth_index` and attach to their own
      // account row at parse time. An UPSTREAM 401/403 backs the account off
      // for an hour (one warning, no per-sync retry — a bad endpoint must
      // never poll every 5 minutes); other failed calls warn per file and
      // stay quota-blind; only a rejected key (management 401/403) stops
      // the run.
      const apiCallPayloadByAuthIndex = new Map<string, { statusCode: number; body: unknown; observedAt: string }>();
      const apiCallQuotaPayloadByAuthIndex = new Map<string, { statusCode: number; body: unknown; observedAt: string }>();
      const fetchedApiCallIndexes = new Set<string>();
      const fetchedMetaIndexes = new Set<string>();
      const apiOrigin = apiCallOriginKey(deps.config.cliproxyBaseUrl);
      const configuredProviders = new Set(deps.config.providers.map((p) => p.provider));
      // Auth indexes are opaque tokens, but never persist one raw in a
      // warning: the short hash distinguishes files for debugging.
      // Client messages are pathname-only and the path builder omits
      // the value, so the scrub below is defense-in-depth.
      const apiFileRef = (authIndex: string) =>
        `auth ${hashIdentity([authIndex])?.slice(0, 8) ?? "unknown"}`;
      let metaQuotaDisabled = 0;
      let liveQuotaDisabled = 0;
      // Arms the per-account upstream-auth backoff and warns once. The
      // 401/403 payload is deliberately NOT attached: the parser would warn
      // a second time for the same event, and the backoff owns this episode.
      // Parameterized (not a loop-variable closure) so both the template
      // rounds and the Meta download + key call below share it.
      const backOffAccount = (provider: string, fileRef: string, key: string, status: number) => {
        deps.apiCallAuthBackoffUntil?.set(key, nowMs + API_CALL_AUTH_BACKOFF_MS);
        deps.apiCallLastCall?.set(key, nowMs);
        pluginErrors.push(
          `${provider} (provider API, ${fileRef}): ` +
            `provider API returned upstream HTTP ${status}; backing off for 1 hour (no live quota until then).`,
        );
      };
      for (const a of discovered.accounts) {
        if (a.status === "disabled" || a.status === "cooling") continue;
        if (!a.authIndex || !configuredProviders.has(a.provider)) continue;
        // Meta live quota (panel-equivalent, stock only): download the
        // account's auth file, extract its `dca_token`, and call
        // `muse-code/key` with a literal bearer — the same read the
        // Management Center panel makes. The token lives in memory for that
        // one call only and the downloaded body is dropped right after
        // extraction; neither is ever logged, persisted, or attached to
        // activity, metrics, errors, plugin state or UI payloads. Polls run
        // at most every 45 minutes per account (plus manual refresh) with
        // the last 2xx answer cached between polls; an upstream 401/403
        // parks the account for an hour like every other family.
        if (a.provider === "meta" || a.provider === "meta-muse") {
          // Either switch off disables the download and the key call for
          // the whole Meta family; the account stays on passive signals.
          if (!isMetaQuotaEnabled(deps.config) || !isLiveQuotaEnabled(deps.config, a.provider)) {
            metaQuotaDisabled += 1;
            continue;
          }
          const authIndex: string = a.authIndex;
          if (!a.fileName) {
            pluginErrors.push(
              `meta (provider API, ${apiFileRef(authIndex)}): ` +
                `auth-files entry carries no file name; live Meta quota unavailable.`,
            );
            continue;
          }
          // Cross-run per-credential throttle, keyed by origin + index like
          // every other family. The Meta interval is 45 minutes, not 4: the
          // panel only reads this endpoint on user refresh, never on poll.
          const metaAccountKey = `${apiOrigin} ${authIndex}`;
          const backoffUntil = deps.apiCallAuthBackoffUntil?.get(metaAccountKey);
          if (backoffUntil !== undefined) {
            if (backoffUntil > nowMs) continue;
            deps.apiCallAuthBackoffUntil?.delete(metaAccountKey);
          }
          // One download + key call per credential per run: distinct
          // auth-files rows can share an `auth_index`, and a forced refresh
          // bypasses the throttle below — without this set one resync would
          // hit the provider twice for the same credential. The single
          // envelope attaches to every row by `auth_index` at parse time, so
          // skipping here loses no row (mirrors fetchedApiCallIndexes in the
          // template branch). The index is marked only once its file has
          // downloaded AND yielded a token (below): a failed download or a
          // token-less file must not block a later row naming a usable file
          // for the same credential.
          if (fetchedMetaIndexes.has(authIndex)) continue;
          const lastCall = deps.apiCallLastCall?.get(metaAccountKey);
          if (
            deps.forceMetaRefresh !== true &&
            lastCall !== undefined &&
            nowMs - lastCall < META_QUOTA_MIN_INTERVAL_MS
          ) {
            // Throttled: reuse the last known-good answer with its original
            // observation time instead of blanking this run's live windows.
            // A missing cache (never fetched, or the last fetch failed)
            // leaves the account unknown this run — never headroom.
            const cached = deps.apiCallCache?.get(`${metaAccountKey} ${META_API_CACHE_KEY}`);
            if (cached !== undefined) {
              apiCallPayloadByAuthIndex.set(authIndex, {
                statusCode: cached.statusCode,
                body: cached.body,
                observedAt: cached.observedAt,
              });
            }
            continue;
          }
          let dcaToken = "";
          try {
            let authText: string;
            try {
              authText = await client.getAuthFileText(a.fileName);
            } catch (err) {
              if (err instanceof CliproxyAuthError) throw err; // stop after first rejected key
              // No throttle stamp here: the failure names this row's file, not
              // the credential, so a later row sharing the auth_index must still
              // get to try its own file below. Only an actual key-call attempt
              // consumes the credential's 45-minute budget (set below). The
              // message quotes nothing from the file: the client reports
              // pathnames only, and the scrub below is defense-in-depth.
              const rawMessage = err instanceof Error ? err.message : "fetch failed";
              const safeMessage = rawMessage.split(authIndex).join(apiFileRef(authIndex));
              pluginErrors.push(
                `meta (provider API, ${apiFileRef(authIndex)}): ` +
                  `auth-file download failed (${safeMessage}); live Meta quota unavailable.`,
              );
              continue;
            }
            try {
              dcaToken = readDcaTokenFromAuthFile(authText);
            } catch (err) {
              if (err instanceof CliproxyAuthError) throw err; // stop after first rejected key
              // No throttle stamp here either: a token-less file says nothing
              // about the credential, so a later row sharing the auth_index
              // must still get to try its own file below. The message is a
              // fixed literal: nothing from the file is ever quoted into a
              // warning.
              pluginErrors.push(
                `meta (provider API, ${apiFileRef(authIndex)}): ` +
                  `auth-file download carries no usable dca_token; live Meta quota unavailable.`,
              );
              continue;
            } finally {
              // The downloaded body is dropped the moment the token is out.
              authText = "";
            }
            // The credential is now in hand: one key call per index from here
            // on, so later rows sharing it reuse this run's envelope at parse
            // time instead of hitting the provider again.
            fetchedMetaIndexes.add(authIndex);
            let result;
            try {
              result = await client.postMetaMuseCodeKey(authIndex, dcaToken);
            } catch (err) {
              if (err instanceof CliproxyAuthError) throw err; // stop after first rejected key
              deps.apiCallLastCall?.set(metaAccountKey, nowMs);
              const rawMessage = err instanceof Error ? err.message : "fetch failed";
              // The client already scrubs the bearer out of its own errors;
              // the split/join here keeps the account index (an opaque
              // token) and the bearer out of the persisted warning either
              // way. Both scrub from the same message so neither can leak
              // through the other.
              const safeMessage = rawMessage
                .split(authIndex)
                .join(apiFileRef(authIndex))
                .split(dcaToken)
                .join(apiFileRef(authIndex));
              pluginErrors.push(
                `meta (provider API, ${apiFileRef(authIndex)}): ` +
                  `${safeMessage}; live Meta quota unavailable.`,
              );
              continue;
            } finally {
              // The bearer lives in memory for the one call above only.
              dcaToken = "";
            }
            deps.apiCallLastCall?.set(metaAccountKey, nowMs);
            const observedAt = deps.now;
            if (result.statusCode === 401 || result.statusCode === 403) {
              backOffAccount("meta", apiFileRef(authIndex), metaAccountKey, result.statusCode);
              continue;
            }
            if (result.statusCode >= 200 && result.statusCode < 300) {
              deps.apiCallCache?.set(`${metaAccountKey} ${META_API_CACHE_KEY}`, {
                statusCode: result.statusCode,
                body: result.body,
                observedAt,
              });
            }
            apiCallPayloadByAuthIndex.set(authIndex, {
              statusCode: result.statusCode,
              body: result.body,
              observedAt,
            });
          } finally {
            // Belt and braces: no exit path above may retain the bearer.
            dcaToken = "";
          }
          continue;
        }
        const templateKey = apiCallTemplateKeyForProvider(a.provider);
        if (!templateKey) continue;
        // Per-provider kill switch (`apiCallEnabled` in the company config,
        // on by default for antigravity/devin/meta): a disabled family makes
        // no credential-bearing calls at all and stays on passive signals.
        if (!isLiveQuotaEnabled(deps.config, a.provider)) {
          liveQuotaDisabled += 1;
          continue;
        }
        // Expired access tokens skip the call for families stock api-call
        // does NOT refresh (devin, codex, claude) — a 401 inside a 200
        // envelope is certain, so do not spend it. Antigravity/meta/xai
        // resolve or refresh tokens server-side, so they are never skipped.
        if (
          (a.provider === "devin" || a.provider === "codex" || a.provider === "claude") &&
          a.tokenExpiresAt
        ) {
          const expiryMs = Date.parse(a.tokenExpiresAt);
          if (!Number.isNaN(expiryMs) && expiryMs <= nowMs) continue;
        }
        if (fetchedApiCallIndexes.has(a.authIndex)) continue;
        fetchedApiCallIndexes.add(a.authIndex);
        const authIndex: string = a.authIndex;
        // Cross-run per-credential throttle, keyed by origin + index so two
        // companies on the same CLIProxy share one bucket per credential.
        const accountKey = `${apiOrigin} ${authIndex}`;
        // Upstream-auth backoff: a provider-side 401/403 parks the account
        // (no calls at all) until the stored time. Expired entries are
        // dropped on encounter so the map cannot grow stale.
        const backoffUntil = deps.apiCallAuthBackoffUntil?.get(accountKey);
        if (backoffUntil !== undefined) {
          if (backoffUntil > nowMs) continue;
          deps.apiCallAuthBackoffUntil?.delete(accountKey);
        }
        const lastCall = deps.apiCallLastCall?.get(accountKey);
        if (lastCall !== undefined && nowMs - lastCall < API_CALL_MIN_INTERVAL_MS) {
          // Throttled: reuse the last known-good answers with their original
          // observation times instead of blanking this run's live windows. A
          // missing cache (never fetched, or the last fetch failed) leaves the
          // account unknown this run — never headroom.
          const cached = deps.apiCallCache?.get(`${accountKey} ${templateKey}`);
          if (cached !== undefined) {
            apiCallPayloadByAuthIndex.set(authIndex, {
              statusCode: cached.statusCode,
              body: cached.body,
              observedAt: cached.observedAt,
            });
          }
          // Remembered working URL first — same order as the live loop, so
          // a stale groupless discovery entry never shadows the winner.
          const rememberedQuota = deps.apiCallQuotaChoice?.get(accountKey);
          const quotaKeys = apiCallQuotaTemplateKeysForProvider(a.provider);
          const orderedQuotaKeys =
            rememberedQuota !== undefined && (quotaKeys as string[]).includes(rememberedQuota)
              ? [rememberedQuota, ...quotaKeys.filter((k) => k !== rememberedQuota)]
              : quotaKeys;
          for (const quotaKey of orderedQuotaKeys) {
            const cachedQuota = deps.apiCallCache?.get(`${accountKey} ${quotaKey}`);
            if (cachedQuota !== undefined) {
              apiCallQuotaPayloadByAuthIndex.set(authIndex, {
                statusCode: cachedQuota.statusCode,
                body: cachedQuota.body,
                observedAt: cachedQuota.observedAt,
              });
              break;
            }
          }
          continue;
        }
        try {
          const result = await client.postApiCall(templateKey, authIndex);
          deps.apiCallLastCall?.set(accountKey, nowMs);
          const observedAt = deps.now;
          if (result.statusCode === 401 || result.statusCode === 403) {
            backOffAccount(a.provider, apiFileRef(authIndex), accountKey, result.statusCode);
            continue;
          }
          if (result.statusCode >= 200 && result.statusCode < 300) {
            deps.apiCallCache?.set(`${accountKey} ${templateKey}`, {
              statusCode: result.statusCode,
              body: result.body,
              observedAt,
            });
          }
          apiCallPayloadByAuthIndex.set(authIndex, {
            statusCode: result.statusCode,
            body: result.body,
            observedAt,
          });
        } catch (err) {
          if (err instanceof CliproxyAuthError) throw err; // stop after first rejected key
          // A provider hit happened even when it fails (transport error,
          // upstream envelope rejection), so the throttle still records it.
          deps.apiCallLastCall?.set(accountKey, nowMs);
          const rawMessage = err instanceof Error ? err.message : "fetch failed";
          const safeMessage = rawMessage.split(authIndex).join(apiFileRef(authIndex));
          pluginErrors.push(`${a.provider} (provider API, ${apiFileRef(authIndex)}): ${safeMessage}`);
          continue;
        }
        // Antigravity quota summary: the winning `retrieveUserQuotaSummary`
        // answer, tried in panel order with the remembered working URL first.
        // It needs the account's project id for the `{"project": …}` body;
        // without one no call is possible and the parser notes plan-only.
        if (a.provider !== "antigravity") continue;
        const projectId = a.quotaProjectId;
        if (projectId === null) continue; // parser warns plan-only
        if (!isSafeApiCallProjectId(projectId)) {
          pluginErrors.push(
            `${a.provider} (provider API quota, ${apiFileRef(authIndex)}): ` +
              `ignoring an unusable project id; quota windows unavailable (plan evidence only).`,
          );
          continue;
        }
        const remembered = deps.apiCallQuotaChoice?.get(accountKey);
        const quotaKeys = apiCallQuotaTemplateKeysForProvider(a.provider);
        const orderedKeys =
          remembered !== undefined && (quotaKeys as string[]).includes(remembered)
            ? [remembered, ...quotaKeys.filter((k) => k !== remembered)]
            : quotaKeys;
        let grouplessOk: { key: string; statusCode: number; body: unknown } | null = null;
        let warnable: { statusCode: number; body: unknown } | null = null;
        let quotaWon = false;
        for (const quotaKey of orderedKeys) {
          let result;
          try {
            result = await client.postApiCall(quotaKey, authIndex, { projectId });
          } catch (err) {
            if (err instanceof CliproxyAuthError) throw err; // stop after first rejected key
            deps.apiCallLastCall?.set(accountKey, nowMs);
            const rawMessage = err instanceof Error ? err.message : "fetch failed";
            const safeMessage = rawMessage.split(authIndex).join(apiFileRef(authIndex));
            pluginErrors.push(`${a.provider} (provider API quota, ${apiFileRef(authIndex)}): ${safeMessage}`);
            break;
          }
          deps.apiCallLastCall?.set(accountKey, nowMs);
          const observedAt = deps.now;
          if (result.statusCode === 401 || result.statusCode === 403) {
            backOffAccount(a.provider, apiFileRef(authIndex), accountKey, result.statusCode);
            grouplessOk = null;
            warnable = null;
            break;
          }
          if (result.statusCode >= 200 && result.statusCode < 300) {
            if (hasAntigravityQuotaGroups(result.body)) {
              deps.apiCallCache?.set(`${accountKey} ${quotaKey}`, {
                statusCode: result.statusCode,
                body: result.body,
                observedAt,
              });
              deps.apiCallQuotaChoice?.set(accountKey, quotaKey);
              apiCallQuotaPayloadByAuthIndex.set(authIndex, {
                statusCode: result.statusCode,
                body: result.body,
                observedAt,
              });
              quotaWon = true;
              break;
            }
            // A 2xx without groups may mean this backend holds no summary —
            // remember it as a fallback but keep trying the remaining URLs.
            if (!grouplessOk) grouplessOk = { key: quotaKey, statusCode: result.statusCode, body: result.body };
            continue;
          }
          // Non-auth upstream error: keep the first for the parser warning,
          // keep trying the remaining URLs for a usable answer.
          if (!warnable) warnable = { statusCode: result.statusCode, body: result.body };
        }
        if (quotaWon) continue;
        // No winning URL: attach the best evidence so the parser warns
        // honestly (a groupless 2xx reads "carries no quota groups"; an error
        // reads its upstream status). A groupless 2xx caches like any
        // known-good answer, so throttled runs reuse it instead of going quiet.
        const fallback = grouplessOk ?? warnable;
        if (fallback) {
          const observedAt = deps.now;
          if (grouplessOk) {
            deps.apiCallCache?.set(`${accountKey} ${grouplessOk.key}`, {
              statusCode: grouplessOk.statusCode,
              body: grouplessOk.body,
              observedAt,
            });
          }
          apiCallQuotaPayloadByAuthIndex.set(authIndex, {
            statusCode: fallback.statusCode,
            body: fallback.body,
            observedAt,
          });
        }
      }
      if (metaQuotaDisabled > 0) {
        pluginErrors.push(
          `meta quota disabled by config (metaQuota.enabled/apiCallEnabled) for ${metaQuotaDisabled} account(s); ` +
            `no auth-file download or provider-API call was made for them this run.`,
        );
      }
      if (liveQuotaDisabled > 0) {
        pluginErrors.push(
          `live quota disabled by config (apiCallEnabled) for ${liveQuotaDisabled} account(s); ` +
            `no provider-API call was made for them this run.`,
        );
      }

      const { accounts, unkeyed, warnings, quotaWarnings } = parseAuthFiles(authFiles, {
        now: deps.now,
        allowLists: deps.config.providerWindows,
        pluginPayloadByAccountKey,
        apiCallPayloadByAuthIndex,
        apiCallQuotaPayloadByAuthIndex,
        apiCallObservedAt: deps.now,
        showAccountEmails: deps.config.showAccountEmails === true,
      });

      // Group by stable row key: duplicates defeat keying (spike G-K1) and
      // alarm loudly. The parser already drops repeats; a repeated key here
      // means two entries hashed alike — keep the first.
      const byKey = new Map<string, ParsedAccount>();
      for (const a of accounts) {
        if (!byKey.has(a.key)) byKey.set(a.key, a);
      }

      const {
        rows,
        drift,
        accepted: acceptedDrift,
      } = accountsToRows(byKey, deps.config.providers, unkeyed, deps.config.ignoredProviders);

      // Per-credential live served sets (best-effort): one pinned
      // `GET auth-files/models?name=<file>` per enabled auth file, grouped by
      // auth-file provider. A missing endpoint (404 on every file, e.g. an
      // older CLIProxy) degrades to the `model_quotas` heuristic with a
      // warning; auth failures propagate to the strike budget like every
      // other management GET.
      const servedSets = await fetchServedSets(client, accounts);
      // Refused served-set names are leftover non-account state (retired
      // plugins), not a fetch failure: one quiet drift finding per file and
      // provider, never a per-run sync error. The name check stays as-is.
      // Findings the operator explicitly accepted stay out of the drift list
      // (and the activity feed) and are reported as accepted instead.
      for (const r of servedSets.refused) {
        const hash = r.fileRef.startsWith(AUTH_FILE_REF_PREFIX)
          ? r.fileRef.slice(AUTH_FILE_REF_PREFIX.length)
          : r.fileRef;
        const target = deps.config.ignoredAuthFileRefs.includes(hash) ? acceptedDrift : drift;
        for (const provider of r.providers) {
          target.push({
            kind: "untrusted-auth-file",
            provider,
            detail:
              `${r.fileRef} is not a servable account credential, so its live served set was skipped ` +
              `(refused name stays refused; the file's model_quotas heuristic still counts). ` +
              `If this file belongs to a retired plugin, removing it from CLIProxy clears this finding.`,
          });
        }
      }

      // Served-model catalog (best-effort): live `/v1/models` with the
      // *client* key, intersected with the auth-file list. A failed or
      // unconfigured catalog only disables derivation + overlap detection
      // for this run — quota aggregation still proceeds. Client-key 401/403s
      // are ordinary fetch failures here: they never touch the management
      // strike budget (different key, no host lockout).
      const catalog = await fetchModelCatalog(deps);
      // Live served sets supersede the heuristic per credential: an account
      // whose file answered successfully claims models only through its live
      // set, so a stale `model_quotas` key cannot fabricate an overlap.
      // Accounts with no usable file name (or a failed fetch) keep the
      // heuristic — that is the fallback. Disabled accounts are excluded
      // everywhere else (quota aggregation, served-set fetching); they are
      // excluded here too, so disabling a credential clears its claims —
      // including `owned_by` claims, which read scope (not quota keys).
      const quotaAccounts = accounts.filter(
        (a) => a.status !== "disabled" && !(a.fileName && servedSets.okFiles.has(a.fileName)),
      );
      const disabledProviders = new Set(
        accounts.filter((a) => a.status === "disabled").map((a) => a.provider),
      );
      const enabledProviders = new Set(
        accounts.filter((a) => a.status !== "disabled").map((a) => a.provider),
      );
      // Belt and braces with the scope above: the `owned_by` fallback must
      // not let a provider without credential evidence claim catalog ids. A
      // disabled Claude file would otherwise let `anthropic` claim a model
      // only Antigravity can serve, hiding Antigravity's usable model as an
      // overlap. Providers with live evidence are still gated by liveOk; this
      // covers the no-live-evidence path.
      const ownedByEligible = [...enabledProviders];
      const derivation = deriveProviderModels(catalog.served, {
        authProviders: [
          ...new Set([
            ...enabledProviders,
            // Configured-but-undiscovered providers keep the heuristic
            // fallback; a configured provider whose credentials are all
            // disabled claims nothing.
            ...deps.config.providers
              .map((p) => p.provider)
              .filter((p) => enabledProviders.has(p) || !disabledProviders.has(p)),
          ]),
        ],
        ownedByEligible,
        observedKeysByProvider: observedModelKeysByProvider(quotaAccounts),
        servedByProvider: servedSets.byProvider,
        liveOkProviders: [...servedSets.okProviders],
      });
      for (const overlap of derivation.overlaps) {
        for (const provider of overlap.providers) {
          drift.push({
            kind: "model-overlap",
            provider,
            detail:
              `model ${JSON.stringify(overlap.id)} is served by CLIProxy and maps to more than one provider ` +
              `(${overlap.providers.join(", ")}); it is not counted as ${provider}'s proven model. ` +
              `Quota still groups by auth-file provider. If this id comes from an openai-compat entry, ` +
              `setting that entry's stock prefix field disambiguates it (optional).`,
          });
        }
      }

      // Provider-side read-model extras (usage page only — never ledger,
      // routing, or quota verdicts). Both ride the sync cadence, at most one
      // fetch each per run, and both fail soft: the last-known snapshot stays
      // and a scrubbed note joins the warnings so the page shows stale data
      // with its timestamp instead of fresh-looking emptiness (T9).
      const { spendNote, countsNote } = await syncReadModelExtras(deps, client);

      const errors = [
        ...pluginErrors,
        ...warnings,
        ...servedSets.warnings,
        ...catalog.warnings,
        ...derivation.warnings,
        ...(spendNote ? [spendNote] : []),
        ...(countsNote ? [countsNote] : []),
      ];
      const providerModels: Record<string, string[]> | undefined =
        catalog.available ? derivation.providerModels : undefined;
      const modelOverlaps: ModelOverlap[] | undefined =
        catalog.available ? derivation.overlaps : undefined;
      // Human display names for proven ids only (per-file served-set names,
      // scrubbed at parse time; never a routing key). Absent when no file
      // answered with names.
      let providerModelNames: Record<string, Record<string, string>> | undefined;
      if (catalog.available) {
        const names: Record<string, Record<string, string>> = {};
        for (const [provider, ids] of Object.entries(derivation.providerModels)) {
          const perFile = servedSets.displayNames.get(provider);
          if (!perFile) continue;
          const picked: Record<string, string> = {};
          for (const id of ids) {
            const displayName = perFile.get(id);
            if (displayName) picked[id] = displayName;
          }
          if (Object.keys(picked).length > 0) names[provider] = picked;
        }
        if (Object.keys(names).length > 0) providerModelNames = names;
      }
      // State-change logging only: new findings log once, cleared findings log
      // once, and persistent findings remind at most daily. Accepted findings
      // never reach the ledger or the feed.
      const ledger = await reconcileDriftLedger(deps, drift, acceptedDrift);
      await deps.saveDriftLedger(ledger);
      const result = finish({
        skipped: false,
        skipReason: null,
        accountsSeen: accounts.length,
        rowsWritten: Object.keys(rows).length,
        drift,
        acceptedDrift,
        errors,
        quotaErrors: [...pluginErrors, ...quotaWarnings],
        providerModels,
        providerModelNames,
        modelOverlaps,
      });
      await deps.saveSync(rows, result);
      // A success clears the last failure so the page stops showing it — and
      // logs the recovery exactly once when there was a recorded failure.
      const prevFailure = await deps.loadFailure();
      if (prevFailure) {
        await deps.logActivity(ACTIVITY_SYNC_RECOVERED, {
          companyId: deps.companyId,
          event: ACTIVITY_SYNC_RECOVERED,
          summary: `sync recovered (previous failure: ${prevFailure.message})`,
          failureKind: prevFailure.failureKind ?? "unknown",
          error: prevFailure.message,
        });
      }
      await deps.recordFailure(null);
      return result;
    } catch (err) {
      if (err instanceof CliproxyAuthError) {
        return await recordAuthFailure(deps, strike, nowMs, finish, err);
      }
      // Non-auth failures (CLIProxy down, schema errors, …) never reached
      // last-sync: record the failure under its own key (leaving `finishedAt`
      // — and the min-interval check — untouched) and log it deduped, so the
      // page shows the failure instead of a stale "last successful run".
      const message = `sync failed: ${err instanceof Error ? err.message : "unknown error"}`;
      await logSyncFailure(deps, { kind: "sync-error", message });
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
 * Fetch the live per-credential served sets for model → provider derivation.
 * One pinned `GET auth-files/models?name=<file>` per enabled auth file with
 * a usable entry `name` (deduplicated by name), grouped by auth-file
 * provider — intra-family sharing is one claim, not ambiguity. Successfully
 * fetched file names are reported in `okFiles` (empty answers included) so
 * the caller can let live membership supersede those credentials'
 * `model_quotas` keys; files without a usable name are skipped with a warning
 * (their `model_quotas` evidence still counts). Always best-effort except
 * auth: a 401/403 rethrows to the
 * strike budget; a 404 on *every* file means the endpoint is missing on this
 * CLIProxy build and derivation degrades to the heuristic with one warning;
 * any other per-file failure warns for that file and keeps the rest.
 */
async function fetchServedSets(
  client: CliproxyManagementClient,
  accounts: ParsedAccount[],
): Promise<{
  byProvider: Map<string, Set<string>>;
  /** File names whose served set answered successfully (empty sets included). */
  okFiles: Set<string>;
  /** Providers with at least one successfully fetched file. */
  okProviders: Set<string>;
  warnings: string[];
  /**
   * Files refused for served-set before any network happened (untrusted
   * name): the refusal is correct and stays — the caller reports these as
   * quiet drift, not per-run sync errors. Raw names never leave this
   * function; only hashed file references.
   */
  refused: Array<{ fileRef: string; providers: string[] }>;
  /**
   * Scrubbed human display names per served id (`auth-files/models`
   * `display_name`), grouped by auth-file provider. Display only — never a
   * routing or matching key.
   */
  displayNames: Map<string, Map<string, string>>;
}> {
  const warnings: string[] = [];
  const byProvider = new Map<string, Set<string>>();
  const okFiles = new Set<string>();
  const okProviders = new Set<string>();
  const refused: Array<{ fileRef: string; providers: string[] }> = [];
  const displayNames = new Map<string, Map<string, string>>();
  // Enabled files only; group names so one GET serves every entry sharing it.
  const providersByName = new Map<string, Set<string>>();
  for (const a of accounts) {
    if (a.status === "disabled") continue;
    if (!a.fileName) {
      warnings.push(
        `${a.provider}: auth file for row ${a.key} carries no name; skipping its served-set fetch (model_quotas evidence still counts).`,
      );
      continue;
    }
    let set = providersByName.get(a.fileName);
    if (!set) {
      set = new Set<string>();
      providersByName.set(a.fileName, set);
    }
    set.add(a.provider);
  }
  if (providersByName.size === 0) {
    warnings.push(
      "no enabled auth file exposes a name; skipping the served-set fetch this run (model_quotas heuristic still applies).",
    );
    return { byProvider, okFiles, okProviders, warnings, refused, displayNames };
  }
  let ok = 0;
  let notFound = 0;
  for (const [name, providers] of [...providersByName.entries()].sort()) {
    // Auth-file names can be emails: never persist them raw in warnings.
    // The short hash distinguishes files for debugging without leaking PII.
    const fileRef = `auth file ${hashIdentity([name])?.slice(0, 8) ?? "unknown"}`;
    let payload: unknown;
    try {
      payload = await client.getAuthFileModels(name);
    } catch (err) {
      if (err instanceof CliproxyAuthError) throw err;
      if (err instanceof CliproxyNotFoundError) {
        notFound += 1;
        warnings.push(
          `${[...providers].sort().join(", ")}: served-set fetch for ${fileRef} returned 404; no served evidence from this file this run.`,
        );
        continue;
      }
      if (err instanceof CliproxyConfigError) {
        // Untrusted auth-file name (path-like leftover state from retired
        // plugins, e.g. `auths/…/manifest.json`): refusing to build the
        // served-set path is correct — the name check stays as-is. It is
        // persistent state, not a transient fetch failure, so the caller
        // reports it as quiet drift rather than a per-run sync error. The
        // file's `model_quotas` heuristic still counts.
        refused.push({ fileRef, providers: [...providers].sort() });
        continue;
      }
      // Other per-file failures (network, 5xx, oversized body, rejected
      // redirects) stay sync warnings: they may clear on the next run. The
      // client embeds the rejected redirect-target pathname in its error, and
      // that server-chosen path can echo the auth-file name — so scrub the
      // raw name before persisting, the same way the file reference above
      // masks it. Auth-file names can be emails.
      const rawMessage = err instanceof Error ? err.message : "fetch failed";
      const safeMessage = name ? rawMessage.split(name).join(fileRef) : rawMessage;
      warnings.push(
        `${[...providers].sort().join(", ")}: served-set fetch for ${fileRef} failed (${safeMessage}); no served evidence from this file this run.`,
      );
      continue;
    }
    const parsed = parseModelsPayload(payload, { emptyIsValid: true });
    for (const w of parsed.warnings) {
      warnings.push(`${[...providers].sort().join(", ")} served set (${fileRef}): ${w}`);
    }
    // HTTP success alone does not prove membership: malformed shapes keep
    // this file's quota evidence and the provider's owned_by fallback eligible.
    if (!parsed.recognized) continue;
    ok += 1;
    // A recognized list — even an empty set — is evidence: this file's live
    // membership supersedes its historical model_quotas keys (see the call
    // site), so a stale quota key cannot fabricate an overlap. A found empty
    // list is valid here and must not emit the catalog-wide empty warning.
    okFiles.add(name);
    for (const provider of providers) okProviders.add(provider);
    for (const m of parsed.models) {
      for (const provider of providers) {
        let set = byProvider.get(provider);
        if (!set) {
          set = new Set<string>();
          byProvider.set(provider, set);
        }
        set.add(m.id);
        // Per-file display names win over the id: the sync already fetched
        // this file, so its names are authoritative for its provider.
        if (m.displayName && m.displayName.toLowerCase() !== m.id) {
          let names = displayNames.get(provider);
          if (!names) {
            names = new Map<string, string>();
            displayNames.set(provider, names);
          }
          if (!names.has(m.id)) names.set(m.id, m.displayName);
        }
      }
    }
  }
  if (ok === 0 && notFound === providersByName.size && warnings.length > 0) {
    warnings.push(
      "the served-set endpoint returned 404 for every enabled auth file (older CLIProxy builds lack it); overlap detection falls back to the model_quotas + owned_by heuristic this run.",
    );
  }
  return { byProvider, okFiles, okProviders, warnings, refused, displayNames };
}

/**
 * Fetch the served-model catalog for model → provider derivation. Always
 * best-effort: any failure (or a missing client secret) returns `available:
 * false` with a warning, and the sync proceeds without derivation. Client-key
 * auth failures never reach the management strike budget.
 */
async function fetchModelCatalog(
  deps: SyncDeps,
): Promise<{ served: ServedModel[]; warnings: string[]; available: boolean }> {
  const ref = deps.config.clientApiKeySecretRef;
  if (ref === undefined || ref === null) {
    return {
      served: [],
      warnings: [
        "clientApiKeySecretRef is not set: skipping /v1/models; model → provider derivation and overlap detection stay off this run.",
      ],
      available: false,
    };
  }
  let clientKey: string;
  try {
    clientKey = await deps.resolveClientSecret(ref);
  } catch (err) {
    return {
      served: [],
      warnings: [
        `could not resolve the CLIProxy client API secret: ${err instanceof Error ? err.message : "unknown error"}; skipping /v1/models this run.`,
      ],
      available: false,
    };
  }
  if (!clientKey) {
    return {
      served: [],
      warnings: ["CLIProxy client API secret resolved empty; skipping /v1/models this run."],
      available: false,
    };
  }
  try {
    const modelsClient = new CliproxyClientApiClient({
      baseUrl: deps.config.cliproxyBaseUrl,
      key: clientKey,
      fetchImpl: deps.fetchImpl,
    });
    const payload = await modelsClient.getModels();
    const parsed = parseModelsPayload(payload);
    return {
      served: parsed.models,
      warnings: parsed.warnings.map((w) => `/v1/models: ${w}`),
      available: true,
    };
  } catch (err) {
    return {
      served: [],
      warnings: [
        `/v1/models unavailable (${err instanceof Error ? err.message : "fetch failed"}); model → provider derivation skipped this run.`,
      ],
      available: false,
    };
  } finally {
    // Drop the only in-memory reference to resolved client-key material.
    clientKey = "";
  }
}

/**
 * Scrub parser warnings before they reach persisted state: each warning is
 * sanitized like a status note (emails and credential-like tokens redacted)
 * and empty results are dropped. Returns null when nothing survives.
 */
export function scrubWarnings(warnings: string[]): string | null {
  const cleaned = warnings
    .map((w) => sanitizeStatusMessage(w))
    .filter((w): w is string => typeof w === "string" && w.length > 0);
  return cleaned.length > 0 ? cleaned.join(" | ") : null;
}

/**
 * Provider-side read-model extras for the usage page: OpenRouter spend and
 * CLIProxy request counts. Both are page-only (never ledger, routing, or
 * quota verdicts), at most one fetch each per sync run, and both fail soft —
 * the last-known snapshot is kept and a scrubbed note is returned for the
 * run's warnings, so the page shows stale data with its timestamp (T9).
 */
async function syncReadModelExtras(
  deps: SyncDeps,
  client: CliproxyManagementClient,
): Promise<{ spendNote: string | null; countsNote: string | null }> {
  return {
    spendNote: await syncSpend(deps),
    countsNote: await syncRequestCounts(deps, client),
  };
}

/**
 * OpenRouter credits read. Unconfigured (no ref) → untouched state, no note:
 * the page shows "not configured", never an error. Any failure keeps the
 * last-known snapshot and records a scrubbed note. The secret is resolved
 * per run, travels only as the `Authorization` header to the fixed endpoint
 * constant, and never reaches persisted state (redaction asserted in tests).
 */
async function syncSpend(deps: SyncDeps): Promise<string | null> {
  const ref = deps.config.openRouterSecretRef;
  if (ref === undefined || ref === null) return null;
  if (!deps.httpFetch) return null;
  const prev = await deps.loadSpend().catch(() => null);
  const keep = async (note: string | null) => {
    await deps.saveSpend({ data: prev?.data ?? null, note });
  };
  let secret = "";
  try {
    secret = await deps.resolveSecret(ref);
  } catch (err) {
    const note = scrubWarnings([
      `openrouter spend: could not resolve the OpenRouter secret (${err instanceof Error ? err.message : "unknown error"}); showing last-known.`,
    ]);
    await keep(note);
    return note;
  }
  if (!secret) {
    const note = "openrouter spend: OpenRouter secret resolved empty; showing last-known.";
    await keep(note);
    return note;
  }
  try {
    const data = await fetchOpenRouterCredits({ httpFetch: deps.httpFetch, secret, fetchedAt: deps.now });
    await deps.saveSpend({ data, note: null });
    return null;
  } catch (err) {
    // Defense-in-depth before storage: the message never interpolates the
    // secret, but a transport error could theoretically echo request detail —
    // so the live value is split out first, then the scrubber runs.
    const raw = err instanceof Error ? err.message : "fetch failed";
    const note = scrubWarnings([`openrouter spend: ${raw.split(secret).join("[redacted]")}; showing last-known.`]);
    await keep(note);
    return note;
  } finally {
    secret = "";
  }
}

/**
 * CLIProxy request-count read (optional, default off). The payload's
 * composite `base_url|api_key` keys are aggregated by provider in the worker
 * and discarded before any state write — stored lanes carry provider words
 * and counts only (T1). Auth rejections fail closed WITHOUT spending strikes
 * or stopping the run (the management key already proved good against
 * `auth-files` this run): one warning, then no further probes until the
 * rejection is older than the strike window (30 min, T3) — a rejected
 * endpoint re-probed every sync run risks the host-wide CLIProxy ban that
 * would also take down `auth-files` and the router. The page keeps showing
 * the stored pause note while probes are off. Anything else warns per run
 * and keeps the last-known aggregates.
 */
async function syncRequestCounts(
  deps: SyncDeps,
  client: CliproxyManagementClient,
): Promise<string | null> {
  if (!deps.config.apiKeyUsageEnabled) return null;
  const prev = await deps.loadRequestCounts().catch(() => null);
  const rejectedMs = prev?.authRejectedAt ? Date.parse(prev.authRejectedAt) : NaN;
  if (!Number.isNaN(rejectedMs) && Date.parse(deps.now) - rejectedMs < STRIKE_WINDOW_MS) {
    // Backing off: no probe, keep the stored note and lanes untouched.
    return null;
  }
  const keep = async (note: string | null, rejectedAt?: string | null) => {
    await deps.saveRequestCounts({
      lanes: prev?.lanes ?? [],
      fetchedAt: prev?.fetchedAt ?? null,
      note,
      authRejectedAt: rejectedAt ?? null,
    });
  };
  let payload: unknown;
  try {
    payload = await client.getApiKeyUsage();
  } catch (err) {
    if (err instanceof CliproxyAuthError) {
      // Cross-run pause (no strike): a persistent rejection surfaces via the
      // stored note until the operator looks, without re-probing every run.
      const note =
        `request counts: CLIProxy rejected the key on api-key-usage (HTTP ${err.status}); ` +
        `request-count probes paused for 30 minutes. No strike spent and no probe beyond this run.`;
      await keep(note, deps.now);
      return note;
    }
    const raw = err instanceof Error ? err.message : "fetch failed";
    // Client messages are pathname-only and the path builder omits values,
    // so this scrub is defense-in-depth (same rule as the served-set fetch).
    const note = scrubWarnings([`request counts: unavailable this run (${raw}); showing last-known.`]);
    await keep(note);
    return note;
  }
  try {
    const { lanes, warnings } = parseApiKeyUsage(payload, deps.now);
    const note = warnings.length > 0 ? scrubWarnings(warnings) : null;
    await deps.saveRequestCounts({ lanes, fetchedAt: deps.now, note, authRejectedAt: null });
    return note;
  } catch (err) {
    const raw = err instanceof Error ? err.message : "fetch failed";
    const note = scrubWarnings([`request counts: unreadable payload (${raw}); showing last-known.`]);
    await keep(note);
    return note;
  }
}

/**
 * Turn parsed accounts (keyed by stable row key) into cache rows + per-
 * provider drift findings. Exported so route-level regression tests run the
 * real sync mapping instead of hand-built rows.
 */
export function accountsToRows(
  byKey: Map<string, ParsedAccount>,
  providers: ProviderEntry[],
  unkeyed: number,
  ignoredProviders: readonly string[] = [],
): { rows: Record<string, AccountUsageRow>; drift: DriftFinding[]; accepted: DriftFinding[] } {
  const rows: Record<string, AccountUsageRow> = {};
  const drift: DriftFinding[] = [];
  const accepted: DriftFinding[] = [];
  const configured = new Map(providers.map((p) => [p.provider, p]));
  const ignored = new Set(ignoredProviders.map((p) => p.toLowerCase()));
  const enabledByProvider = new Map<string, number>();
  const discovered = new Set<string>();

  for (const [rowKey, a] of byKey) {
    discovered.add(a.provider);
    if (a.status !== "disabled") {
      enabledByProvider.set(a.provider, (enabledByProvider.get(a.provider) ?? 0) + 1);
    }
    rows[rowKey] = {
      key: rowKey,
      provider: a.provider,
      channel: a.channel,
      displayLabel: a.displayLabel,
      needsSignIn: a.needsSignIn,
      needsSignInHint: a.needsSignInHint,
      status: a.status,
      statusMessage: a.statusMessage,
      priority: a.priority,
      limits: a.limits,
      planType: a.planType,
      checkedAt: a.checkedAt,
      source: "plugin:cliproxy-connector",
      quotaBlind: a.quotaBlind,
      quotaBlindReason: a.quotaBlindReason,
      accountHash: a.accountHash,
      // Resolved open check: parse warnings can carry upstream-shaped text
      // (window names, plan labels), so every warning is scrubbed like a
      // status note BEFORE storage — `lastError` never holds key material.
      lastError: scrubWarnings(a.parseWarnings),
      coolingDown: a.coolingDown,
      cooldownUntil: a.cooldownUntil,
      credits: a.credits,
      overage: a.overage,
      overageObservedAt: a.overageObservedAt,
      quotaMetrics: a.quotaMetrics,
    };
  }
  if (unkeyed > 0) {
    // Entries without a stable identity cannot be keyed across syncs and were
    // ignored. This is a sync warning, not per-provider drift.
  }
  for (const provider of [...discovered].sort()) {
    if (!configured.has(provider)) {
      // Findings the operator explicitly accepted never alert: they are
      // reported as accepted (page) instead of drift (feed).
      const target = ignored.has(provider.toLowerCase()) ? accepted : drift;
      target.push({
        kind: "unconfigured-provider",
        provider,
        detail: `CLIProxy reports ${provider} accounts but no providers[] row maps it to a connection; the router cannot trust quota for ${provider} and treats it as unknown.`,
      });
    }
  }
  for (const entry of [...providers].sort((a, b) => a.provider.localeCompare(b.provider))) {
    if ((enabledByProvider.get(entry.provider) ?? 0) === 0) {
      drift.push({
        kind: "no-enabled-accounts",
        provider: entry.provider,
        detail: `providers[] maps ${entry.provider} to a connection, but CLIProxy reports zero enabled accounts for it; the provider routes as unknown until accounts appear.`,
      });
    }
  }
  return { rows, drift, accepted };
}

/**
 * Reconcile the current drift findings against the persisted ledger and log
 * exactly the state changes: one `drift_detected` per new key, one
 * `drift_cleared` per vanished key, and at most one `drift_still_present`
 * reminder per 24 h per key that stays present. Findings that only became
 * accepted (via a config edit) leave the ledger silently — they did not
 * clear, they were accepted. Returns the updated ledger for the caller to
 * persist.
 *
 * First run after upgrade (no ledger persisted yet — null, as opposed to a
 * persisted-but-empty ledger after an all-clear): seed every current finding
 * as notified "now" and log nothing, so the upgrade itself emits no burst.
 * Only successful syncs reach this function, so a failed or skipped run never
 * seeds, clears or re-detects findings.
 */
export async function reconcileDriftLedger(
  deps: Pick<SyncDeps, "now" | "companyId" | "logActivity" | "loadDriftLedger">,
  drift: DriftFinding[],
  acceptedDrift: DriftFinding[] = [],
): Promise<DriftLedger> {
  const nowMs = Date.parse(deps.now);
  const stored = await deps.loadDriftLedger();
  if (stored === null) {
    const seeded: DriftLedger = {};
    for (const finding of drift) {
      seeded[driftKeyFor(finding)] = {
        kind: finding.kind,
        provider: finding.provider,
        detail: finding.detail,
        firstSeenAt: deps.now,
        lastSeenAt: deps.now,
        lastLoggedAt: deps.now,
      };
    }
    return seeded;
  }
  const ledger = stored;
  const current = new Set(drift.map(driftKeyFor));
  const accepted = new Set(acceptedDrift.map(driftKeyFor));
  for (const finding of drift) {
    const key = driftKeyFor(finding);
    const entry = ledger[key];
    if (!entry) {
      const next: DriftLedgerEntry = {
        kind: finding.kind,
        provider: finding.provider,
        detail: finding.detail,
        firstSeenAt: deps.now,
        lastSeenAt: deps.now,
        lastLoggedAt: deps.now,
      };
      ledger[key] = next;
      await deps.logActivity(ACTIVITY_DRIFT_DETECTED, {
        companyId: deps.companyId,
        event: ACTIVITY_DRIFT_DETECTED,
        summary: `drift detected [${finding.kind}] ${finding.provider}: ${finding.detail}`,
        kind: finding.kind,
        provider: finding.provider,
        detail: finding.detail,
        driftKey: key,
      });
      continue;
    }
    entry.lastSeenAt = deps.now;
    const lastLoggedMs = Date.parse(entry.lastLoggedAt);
    if (Number.isNaN(lastLoggedMs) || nowMs - lastLoggedMs >= ACTIVITY_REMINDER_INTERVAL_MS) {
      entry.lastLoggedAt = deps.now;
      await deps.logActivity(ACTIVITY_DRIFT_STILL_PRESENT, {
        companyId: deps.companyId,
        event: ACTIVITY_DRIFT_STILL_PRESENT,
        summary:
          `drift still present [${finding.kind}] ${finding.provider}: ${finding.detail} ` +
          `(first seen ${entry.firstSeenAt})`,
        kind: finding.kind,
        provider: finding.provider,
        detail: finding.detail,
        driftKey: key,
        firstSeenAt: entry.firstSeenAt,
      });
    }
  }
  for (const key of Object.keys(ledger)) {
    if (current.has(key)) continue;
    const entry = ledger[key] as DriftLedgerEntry;
    delete ledger[key];
    // A finding that moved to accepted (via a config edit) leaves the ledger
    // silently: it did not clear, it was accepted. Only keys absent from both
    // lists emit drift_cleared.
    if (accepted.has(key)) continue;
    await deps.logActivity(ACTIVITY_DRIFT_CLEARED, {
      companyId: deps.companyId,
      event: ACTIVITY_DRIFT_CLEARED,
      summary: `drift cleared [${entry.kind}] ${entry.provider}: ${entry.detail}`,
      kind: entry.kind,
      provider: entry.provider,
      detail: entry.detail,
      driftKey: key,
      firstSeenAt: entry.firstSeenAt,
    });
  }
  return ledger;
}

/**
 * Failure kinds that are setup problems (bad secret, rejected key) log under
 * the stable `setup_error` key; anything else (CLIProxy down, schema errors)
 * logs under `sync_failed`. Either way the log is deduped by failure
 * signature (kind + message): the first occurrence logs once, an identical
 * failure persisting across runs only refreshes the recorded attempt, with at
 * most one reminder row per 24 h. A changed message (or kind) is a new failure
 * and logs anew — e.g. the escalation from first rejection to hard-disable.
 */
export function activityKeyForFailureKind(kind: string): string {
  return kind === "sync-error" ? ACTIVITY_SYNC_FAILED : ACTIVITY_SETUP_ERROR;
}

export async function logSyncFailure(
  deps: Pick<SyncDeps, "now" | "companyId" | "logActivity" | "loadFailure" | "recordFailure">,
  failure: { kind: string; message: string },
): Promise<void> {
  const nowMs = Date.parse(deps.now);
  const activityKey = activityKeyForFailureKind(failure.kind);
  const prev = await deps.loadFailure();
  if (prev && prev.failureKind === failure.kind && prev.message === failure.message) {
    const lastLoggedMs = Date.parse(prev.lastLoggedAt ?? prev.attemptedAt);
    const reminderDue =
      Number.isNaN(lastLoggedMs) || nowMs - lastLoggedMs >= ACTIVITY_REMINDER_INTERVAL_MS;
    await deps.recordFailure({
      ...prev,
      attemptedAt: deps.now,
      lastLoggedAt: reminderDue ? deps.now : (prev.lastLoggedAt ?? prev.attemptedAt),
    });
    if (reminderDue) {
      await deps.logActivity(activityKey, {
        companyId: deps.companyId,
        event: activityKey,
        summary: failure.message,
        failureKind: failure.kind,
        error: failure.message,
        reminder: true,
      });
    }
    return;
  }
  await deps.recordFailure({
    attemptedAt: deps.now,
    message: failure.message,
    failureKind: failure.kind,
    lastLoggedAt: deps.now,
  });
  await deps.logActivity(activityKey, {
    companyId: deps.companyId,
    event: activityKey,
    summary: failure.message,
    failureKind: failure.kind,
    error: failure.message,
  });
}

async function recordAuthFailure(
  deps: SyncDeps,
  strike: StrikeBudgetState,
  nowMs: number,
  finish: (p: Partial<SyncSummary> & { skipped: boolean; skipReason: string | null }) => SyncSummary,
  err: CliproxyAuthError,
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
  await logSyncFailure(deps, { kind: "auth-rejected", message: setupError });
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
  const next: StrikeBudgetState =
    waitUntil
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
