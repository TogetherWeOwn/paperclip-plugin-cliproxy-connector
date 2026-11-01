/**
 * Sync job (cron 2–5 min + on-demand): CLIProxy → plugin cache.
 *
 * Reads the CLIProxy account list + per-provider quota through the proposal
 * §4 safe path (pinned GET allow-list plus the three pinned
 * `api-call` POST templates for Meta/Antigravity/Devin, one call per account
 * per sync), groups accounts by provider, and normalises into
 * `AiConnectionUsage`-shaped rows in the plugin's own namespace. No core
 * changes, no fork.
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
  apiCallTemplateKeyForProvider,
  CliproxyAuthError,
  CliproxyClientApiClient,
  CliproxyConfigError,
  CliproxyManagementClient,
  CliproxyNotFoundError,
  type ManagementFetch,
} from "./cliproxy.js";
import type { ConnectorConfig, ProviderEntry } from "./config.js";
import {
  deriveProviderModels,
  observedModelKeysByProvider,
  parseModelsPayload,
  type ServedModel,
} from "./models.js";
import { hashIdentity, parseAuthFiles, type ParsedAccount } from "./parsers.js";
import type {
  AccountUsageRow,
  DriftFinding,
  ModelOverlap,
  StrikeBudgetState,
  SyncFailure,
  SyncSummary,
} from "./types.js";

export const STRIKE_WINDOW_MS = 30 * 60_000;
export const STRIKE_LIMIT = 2;
export const MIN_SYNC_INTERVAL_MS = 60_000;
/**
 * Minimum gap between two credential-bearing provider-API calls for the same
 * credential (`auth_index`). The scheduled sync runs every 5 minutes, so this
 * bounds live quota reads to at most one call per account per sync even when
 * the on-demand resync action fires back to back — repeated provider hits
 * with stored credentials could otherwise get those accounts flagged.
 */
export const API_CALL_MIN_INTERVAL_MS = 5 * 60_000;

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
  /**
   * Last provider-API call time per credential `auth_index` (epoch millis).
   * The worker owns one shared map across runs; callers that omit it get no
   * cross-run throttling. Tests pass their own map to assert the bound.
   */
  apiCallLastCall?: Map<string, number>;
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

      // Per-file plugin quota fetch is best-effort: a failing plugin route
      // leaves the account on its passive signals (or unknown), never
      // headroom. CLIProxy v8.0.49 requires `?auth_index=<auth index>`
      // (`GetPluginQuota` 400s without it), so one fetch runs per distinct
      // credential index among the provider's enabled accounts; raw payloads
      // ride along by `auth_index` and attach to their own account row at
      // parse time. Entries without an index (older builds) keep the legacy
      // provider-level fetch. Failed fetches warn per file or provider and
      // never spend strikes; only a rejected key (401/403) stops the run.
      const pluginPayloadByProvider = new Map<string, unknown>();
      const pluginPayloadByAuthIndex = new Map<string, unknown>();
      const pluginErrors: string[] = [];
      const fetchedPluginIds = new Map<string, string>();
      const fetchedPluginKeys = new Set<string>();
      // Discovery parse (no payloads): find each enabled account's provider +
      // credential index. The real parse below re-runs with payloads
      // attached; this pass's warnings are discarded.
      const discovered = parseAuthFiles(authFiles, {
        now: deps.now,
        allowLists: deps.config.providerWindows,
      });
      const enabledIndexesByProvider = new Map<string, Set<string>>();
      // Same-provider accounts may advertise different quota plugins: keep
      // each credential's own route so every index is fetched against the
      // plugin that serves it (first wins per index; the provider hint below
      // is only the fallback for rows that advertise nothing).
      const pluginIdByAuthIndex = new Map<string, string>();
      for (const a of discovered.accounts) {
        if (a.status === "disabled" || !a.authIndex) continue;
        let set = enabledIndexesByProvider.get(a.provider);
        if (!set) {
          set = new Set<string>();
          enabledIndexesByProvider.set(a.provider, set);
        }
        set.add(a.authIndex);
        if (a.quotaPluginId && !pluginIdByAuthIndex.has(a.authIndex)) {
          pluginIdByAuthIndex.set(a.authIndex, a.quotaPluginId);
        }
      }
      for (const entry of deps.config.providers) {
        // Explicit config wins for the whole provider; otherwise each
        // credential fetches against its own advertised route
        // (`quota_plugin_id`, unless `supports_quota: false`), so new quota
        // plugins need no config change to start syncing.
        const override = deps.config.pluginQuotaIds[entry.provider];
        const providerHint = discovered.pluginQuotaHints.get(entry.provider);
        // Every advertised id also sets the provider hint, so a missing
        // provider id means no per-index id either: nothing to fetch.
        if (!override && !providerHint) continue;
        const indexes = [...(enabledIndexesByProvider.get(entry.provider) ?? [])].sort();
        // Provider-level route for the legacy no-index fetch below.
        const providerPluginId = (override ?? providerHint) as string;
        if (indexes.length === 0) {
          // No indexed credential for this provider: legacy provider-level
          // fetch (older builds), shared across providers on one plugin id.
          if (fetchedPluginIds.has(providerPluginId)) {
            const first = fetchedPluginIds.get(providerPluginId) as string;
            const prior = pluginPayloadByProvider.get(first);
            if (prior !== undefined) pluginPayloadByProvider.set(entry.provider, prior);
            continue;
          }
          try {
            const payload = await client.getPluginQuota(providerPluginId);
            fetchedPluginIds.set(providerPluginId, entry.provider);
            pluginPayloadByProvider.set(entry.provider, payload);
          } catch (err) {
            if (err instanceof CliproxyAuthError) throw err; // stop after first rejected key
            pluginErrors.push(`${entry.provider} (plugin ${providerPluginId}): ${err instanceof Error ? err.message : "fetch failed"}`);
          }
          continue;
        }
        for (const authIndex of indexes) {
          // Same-provider accounts on different plugins each query their
          // own route; rows that advertise nothing use the provider hint.
          const pluginId = override ?? pluginIdByAuthIndex.get(authIndex) ?? providerHint;
          if (!pluginId) continue;
          const fetchKey = `${pluginId} ${authIndex}`;
          if (fetchedPluginKeys.has(fetchKey)) continue;
          try {
            const payload = await client.getPluginQuota(pluginId, authIndex);
            fetchedPluginKeys.add(fetchKey);
            pluginPayloadByAuthIndex.set(authIndex, payload);
          } catch (err) {
            if (err instanceof CliproxyAuthError) throw err; // stop after first rejected key
            // Auth indexes are opaque tokens, but never persist one raw in a
            // warning: the short hash distinguishes files for debugging.
            // Client messages are pathname-only and the path builder omits
            // the value, so the scrub below is defense-in-depth.
            const fileRef = `auth ${hashIdentity([authIndex])?.slice(0, 8) ?? "unknown"}`;
            const rawMessage = err instanceof Error ? err.message : "fetch failed";
            const safeMessage = rawMessage.split(authIndex).join(fileRef);
            pluginErrors.push(`${entry.provider} (plugin ${pluginId}, ${fileRef}): ${safeMessage}`);
          }
        }
      }

      // Live provider-API quota: one pinned
      // `POST /v0/management/api-call` per distinct credential index among the
      // enabled, configured meta/antigravity/devin accounts — the families the
      // three frozen templates serve. The template comes from an exact
      // allow-map on the auth file's raw provider word, never from fuzzy
      // matching: a `gemini` account must not send its credential through the
      // Antigravity request. Disabled accounts are never called; cooling
      // accounts keep their cooldown (no probe while the provider says
      // wait); one call per index per sync bounds the rate to the sync cadence
      // (every 5 min), and the per-credential throttle below holds that bound
      // across back-to-back resyncs. Raw envelopes ride along by `auth_index`
      // and attach to their own account row at parse time. Failed calls warn
      // per file and stay quota-blind; only a rejected key (401/403) stops
      // the run.
      const apiCallPayloadByAuthIndex = new Map<string, { statusCode: number; body: unknown }>();
      const fetchedApiCallIndexes = new Set<string>();
      const configuredProviders = new Set(deps.config.providers.map((p) => p.provider));
      for (const a of discovered.accounts) {
        if (a.status === "disabled" || a.status === "cooling") continue;
        if (!a.authIndex || !configuredProviders.has(a.provider)) continue;
        const templateKey = apiCallTemplateKeyForProvider(a.provider);
        if (!templateKey) continue;
        if (fetchedApiCallIndexes.has(a.authIndex)) continue;
        fetchedApiCallIndexes.add(a.authIndex);
        // Cross-run per-credential throttle: skip the provider call when this
        // credential was already called less than 5 minutes ago (e.g. a manual
        // resync right after the scheduled sync). The account stays unknown
        // this run rather than spending another credential-bearing hit.
        const lastCall = deps.apiCallLastCall?.get(a.authIndex);
        if (lastCall !== undefined && nowMs - lastCall < API_CALL_MIN_INTERVAL_MS) continue;
        try {
          const result = await client.postApiCall(templateKey, a.authIndex);
          deps.apiCallLastCall?.set(a.authIndex, nowMs);
          apiCallPayloadByAuthIndex.set(a.authIndex, {
            statusCode: result.statusCode,
            body: result.body,
          });
        } catch (err) {
          if (err instanceof CliproxyAuthError) throw err; // stop after first rejected key
          // A provider hit happened even when it fails (transport error,
          // upstream envelope rejection), so the throttle still records it.
          deps.apiCallLastCall?.set(a.authIndex, nowMs);
          // Auth indexes are opaque tokens, but never persist one raw in a
          // warning: the short hash distinguishes files for debugging.
          const fileRef = `auth ${hashIdentity([a.authIndex])?.slice(0, 8) ?? "unknown"}`;
          const rawMessage = err instanceof Error ? err.message : "fetch failed";
          const safeMessage = rawMessage.split(a.authIndex).join(fileRef);
          pluginErrors.push(`${a.provider} (provider API, ${fileRef}): ${safeMessage}`);
        }
      }

      const { accounts, unkeyed, warnings } = parseAuthFiles(authFiles, {
        now: deps.now,
        allowLists: deps.config.providerWindows,
        pluginPayloadByProvider,
        pluginPayloadByAuthIndex,
        apiCallPayloadByAuthIndex,
        apiCallObservedAt: deps.now,
      });

      // Group by stable row key: duplicates defeat keying (spike G-K1) and
      // alarm loudly. The parser already drops repeats; a repeated key here
      // means two entries hashed alike — keep the first.
      const byKey = new Map<string, ParsedAccount>();
      for (const a of accounts) {
        if (!byKey.has(a.key)) byKey.set(a.key, a);
      }

      const { rows, drift } = accountsToRows(byKey, deps.config.providers, unkeyed);

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
      for (const r of servedSets.refused) {
        for (const provider of r.providers) {
          drift.push({
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

      const errors = [...pluginErrors, ...warnings, ...servedSets.warnings, ...catalog.warnings, ...derivation.warnings];
      const providerModels: Record<string, string[]> | undefined =
        catalog.available ? derivation.providerModels : undefined;
      const modelOverlaps: ModelOverlap[] | undefined =
        catalog.available ? derivation.overlaps : undefined;
      for (const d of drift) {
        await deps.logActivity(`cliproxy-connector drift [${d.kind}] ${d.provider}: ${d.detail}`, {
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
        providerModels,
        modelOverlaps,
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
}> {
  const warnings: string[] = [];
  const byProvider = new Map<string, Set<string>>();
  const okFiles = new Set<string>();
  const okProviders = new Set<string>();
  const refused: Array<{ fileRef: string; providers: string[] }> = [];
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
    return { byProvider, okFiles, okProviders, warnings, refused };
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
    const parsed = parseModelsPayload(payload);
    ok += 1;
    // A successful answer — even an empty set — is evidence: this file's live
    // membership supersedes its historical model_quotas keys (see the call
    // site), so a stale quota key cannot fabricate an overlap.
    okFiles.add(name);
    for (const provider of providers) okProviders.add(provider);
    for (const w of parsed.warnings) {
      warnings.push(`${[...providers].sort().join(", ")} served set (${fileRef}): ${w}`);
    }
    for (const m of parsed.models) {
      for (const provider of providers) {
        let set = byProvider.get(provider);
        if (!set) {
          set = new Set<string>();
          byProvider.set(provider, set);
        }
        set.add(m.id);
      }
    }
  }
  if (ok === 0 && notFound > 0 && warnings.length > 0) {
    warnings.push(
      "the served-set endpoint returned 404 for every enabled auth file (older CLIProxy builds lack it); overlap detection falls back to the model_quotas + owned_by heuristic this run.",
    );
  }
  return { byProvider, okFiles, okProviders, warnings, refused };
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
 * Turn parsed accounts (keyed by stable row key) into cache rows + per-
 * provider drift findings. Exported so route-level regression tests run the
 * real sync mapping instead of hand-built rows.
 */
export function accountsToRows(
  byKey: Map<string, ParsedAccount>,
  providers: ProviderEntry[],
  unkeyed: number,
): { rows: Record<string, AccountUsageRow>; drift: DriftFinding[] } {
  const rows: Record<string, AccountUsageRow> = {};
  const drift: DriftFinding[] = [];
  const configured = new Map(providers.map((p) => [p.provider, p]));
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
      lastError: a.parseWarnings.length > 0 ? a.parseWarnings.join(" | ") : null,
      coolingDown: a.coolingDown,
      cooldownUntil: a.cooldownUntil,
    };
  }
  if (unkeyed > 0) {
    // Entries without a stable identity cannot be keyed across syncs and were
    // ignored. This is a sync warning, not per-provider drift.
  }
  for (const provider of [...discovered].sort()) {
    if (!configured.has(provider)) {
      drift.push({
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
