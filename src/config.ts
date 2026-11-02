/**
 * Company-level connector configuration: parsing, validation and defaults.
 *
 * v2 is per-provider: the operator enters one row per CLIProxy provider
 * family (`providers: [{ provider, connectionId, completeInventory }]`), once.
 * Accounts added, removed or disabled in CLIProxy appear in or vanish from
 * the sync cache with zero config change (auto-discovery).
 *
 * The host carries company config opaquely (`ctx.config.get(companyId)`), so
 * this module is the single place that turns it into a typed, validated
 * `ConnectorConfig`. Anything security-relevant (loopback base URL, explicit
 * key header, secret_ref shape) fails validation loudly here.
 */

export interface ProviderEntry {
  /** CLIProxy provider string, normalized lowercase (e.g. `claude`). */
  provider: string;
  /** Paperclip connection id for this provider family (stock model ids). */
  connectionId: string;
  /**
   * The operator confirms this provider has no hidden config-key credentials
   * (CLIProxy omits `claude-api-key`, `codex-api-key` incl. MetaKey/XAIKey
   * aliases, `openai-compatibility` and vertex from `auth-files`). Defaults
   * to false: a provider with unconfirmed inventory can only reach `allowed`
   * or `unknown`, never `exhausted` (fail open, never wait).
   */
  completeInventory: boolean;
}

export interface ConnectorConfig {
  /** Loopback-only CLIProxy base URL, e.g. `http://127.0.0.1:8317`. */
  cliproxyBaseUrl: string;
  /** Management-key header name, e.g. `X-Management-Key`. No silent default. */
  managementKeyHeader: string;
  /** Paperclip `secret_ref` object for the management key. Never persisted. */
  managementSecretRef: unknown;
  /**
   * Board `secret_ref` for the CLIProxy *client* (non-management) API key,
   * used only for `GET /v1/models` (served-model list for model → provider
   * derivation). Resolved per run and never persisted, under the same
   * loopback and `redirect:"manual"` rules as the management path. Optional
   * for validation (missing → derivation and overlap detection stay off with
   * a warning; quota aggregation still runs), required for full function.
   */
  clientApiKeySecretRef?: unknown;
  /** Sync cadence in minutes. The cron job runs every 5; larger values skip. */
  syncIntervalMinutes: number;
  /** Default reserve: providers at or below this remaining % are not headroom. */
  reservePercent: number;
  /** Per-pool reserve overrides keyed by pool id. */
  perPoolReservePercent: Record<string, number>;
  /** Wait before re-probing unknown/stale telemetry. */
  recheckSeconds: number;
  /** Freshness bound = syncIntervalMinutes × this (default 2). */
  maxAgeMultiplier: number;
  /** Fail-open grace = maxAge × this (default 3). */
  graceMultiplier: number;
  /** Tolerance for `checkedAt` slightly in the future. */
  futureSkewSeconds: number;
  /** One row per provider family, never per account. */
  providers: ProviderEntry[];
  /** Per-provider gating-window allow-list (lowercased substring match). */
  providerWindows: Record<string, string[]>;
  /** CLIProxy plugin id per provider for quota fetch (our five plugins). */
  pluginQuotaIds: Record<string, string>;
  /**
   * Per-provider kill switch for the pinned live `api-call` rounds. An entry
   * of `false` disables all credential-bearing provider-API calls for that
   * provider family (no subscription round, no quota round); anything else —
   * including a missing entry — falls back to `DEFAULT_LIVE_QUOTA_PROVIDERS`
   * below (on for antigravity/devin/meta, off for everything else, which has
   * no template anyway). In-memory Maps (`apiCallLastCall`, backoff) are
   * untouched by a kill switch flip, so re-enabling re-proves on the next run.
   */
  apiCallEnabled: Record<string, boolean>;
  /** Operator confirms the page audience exposure is intended (proposal §4.4). */
  audienceConfirmed: boolean;
}

export const DEFAULTS = {
  syncIntervalMinutes: 5,
  reservePercent: 10,
  recheckSeconds: 60,
  maxAgeMultiplier: 2,
  graceMultiplier: 3,
  futureSkewSeconds: 30,
} as const;

/**
 * Default gating-window allow-lists per provider (lowercased substrings).
 * From the TWO-578 spike matrix: official passive signals where they exist,
 * plugin normalized bucket windows otherwise, `unknown` providers carry no
 * allow-list and are quota-blind by design.
 */
export const DEFAULT_PROVIDER_WINDOWS: Record<string, string[]> = {
  claude: ["5h", "7d", "unified"],
  // Stock CLIProxy Codex headers carry bare `primary` / `secondary` windows
  // (`x-codex-primary-used-percent`) alongside namespaced ones (`5h-primary`):
  // both must gate, or stock quotas never constrain routing.
  codex: ["codex", "5h", "weekly", "primary", "secondary"],
  // Live provider-API windows: the Devin Connect-RPC serves `daily` +
  // `weekly` (`parseDevinQuota`), and Antigravity quota-summary buckets gate
  // on their time window (`parseAntigravityQuota`). Meta stays panel-only
  // (no connector template), so its row below is window-name parity only.
  meta: ["meta", "window", "weekly"],
  antigravity: ["antigravity", "5h", "weekly", "daily", "monthly"],
  devin: ["devin", "5h", "weekly", "daily"],
  synthetic: ["weekly", "rolling-5h", "5h", "subscription"],
  "nvidia-nim": ["rpm", "minute"],
  cloudflare: ["daily", "neurons"],
  zai: ["5h", "weekly"],
  "opencode-go": ["rolling", "weekly", "monthly", "5h"],
};

/** Single path segment: no slashes, no dots, no encoding tricks. Shared with the management client. */
export const SINGLE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Strip trailing slashes without a regex. The `/\/+$/` form trips CodeQL
 * `js/polynomial-redos` (low risk here — the value is operator config that
 * passes loopback validation — but a high must not merge open).
 */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

export function isLoopbackUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  if (host === "[::1]") return true;
  return false;
}

export interface ConfigValidation {
  ok: boolean;
  warnings: string[];
  errors: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseConfig(raw: unknown): { config: ConnectorConfig; validation: ConfigValidation } {
  const warnings: string[] = [];
  const errors: string[] = [];
  const r = (isPlainObject(raw) ? raw : {}) as Record<string, unknown>;

  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;

  const cliproxyBaseUrl = stripTrailingSlashes(str(r.cliproxyBaseUrl).trim());
  const managementKeyHeader = str(r.managementKeyHeader).trim();

  if (!cliproxyBaseUrl) {
    errors.push("cliproxyBaseUrl is required (loopback CLIProxy base URL).");
  } else if (!isLoopbackUrl(cliproxyBaseUrl)) {
    errors.push(
      `cliproxyBaseUrl must be loopback (http(s)://localhost, 127.0.0.1 or ::1); got ${cliproxyBaseUrl}.`,
    );
  }
  if (!managementKeyHeader) {
    errors.push(
      "managementKeyHeader is required: the exact header name CLIProxy expects the management key in. There is no default on purpose.",
    );
  }
  if (r.managementSecretRef === undefined || r.managementSecretRef === null) {
    errors.push("managementSecretRef is required: board-created secret_ref for the CLIProxy management key.");
  } else if (typeof r.managementSecretRef !== "object") {
    errors.push("managementSecretRef must be the secret_ref object shape; legacy string UUIDs fail closed.");
  }
  if (r.clientApiKeySecretRef === undefined || r.clientApiKeySecretRef === null) {
    warnings.push(
      "clientApiKeySecretRef is not set: the plugin cannot fetch /v1/models, so model → provider derivation and overlap detection stay off (quota aggregation still runs). Add the board secret_ref for the CLIProxy client API key for full function.",
    );
  } else if (typeof r.clientApiKeySecretRef !== "object") {
    errors.push("clientApiKeySecretRef must be the secret_ref object shape; legacy string UUIDs fail closed.");
  }

  const reservePercent = num(r.reservePercent, DEFAULTS.reservePercent);
  if (!(reservePercent > 0 && reservePercent < 50)) {
    errors.push(`reservePercent must be within (0, 50); got ${reservePercent}.`);
  }
  const syncIntervalMinutes = num(r.syncIntervalMinutes, DEFAULTS.syncIntervalMinutes);
  if (!(syncIntervalMinutes >= 1 && syncIntervalMinutes <= 60)) {
    errors.push(`syncIntervalMinutes must be within [1, 60]; got ${syncIntervalMinutes}.`);
  }

  // v2 provider rows. Any non-empty provider string is accepted as-is
  // (raw auth-file word, trimmed and lowercased): future providers such as
  // `openrouter` need no code change, and `cloudflare-workers-ai` matches its
  // accounts exactly. A typo'd row simply matches no accounts and drift-warns
  // as having zero enabled accounts instead of failing the sync closed.
  const providers: ProviderEntry[] = [];
  const providersIn = r.providers ?? [];
  const seenProviders = new Set<string>();
  const seenConnections = new Map<string, string>();
  if (!Array.isArray(providersIn)) {
    errors.push("providers must be a list of { provider, connectionId, completeInventory } rows.");
  } else {
    for (const [index, entryRaw] of providersIn.entries()) {
      const where = `providers[${index}]`;
      if (!isPlainObject(entryRaw)) {
        errors.push(`${where} must be an object with provider and connectionId.`);
        continue;
      }
      const provider = str(entryRaw.provider).trim().toLowerCase();
      const connectionId = str(entryRaw.connectionId).trim();
      if (!provider) {
        errors.push(`${where}.provider is required: the CLIProxy provider string from auth-files (e.g. claude, codex, meta).`);
        continue;
      }
      if (seenProviders.has(provider)) {
        errors.push(`${where}: duplicate provider row for ${JSON.stringify(provider)}; keep one row per provider.`);
        continue;
      }
      seenProviders.add(provider);
      if (!connectionId) {
        errors.push(`${where} for ${JSON.stringify(provider)}: connectionId must be a non-empty Paperclip connection id.`);
        continue;
      }
      const prev = seenConnections.get(connectionId);
      if (prev !== undefined && prev !== provider) {
        warnings.push(
          `providers: connection ${connectionId} is mapped from both ${prev} and ${provider}; per-provider aggregates may attribute the same connection twice.`,
        );
      } else {
        seenConnections.set(connectionId, provider);
      }
      providers.push({
        provider,
        connectionId,
        completeInventory: entryRaw.completeInventory === true,
      });
    }
  }
  if (providers.length === 0) {
    warnings.push("providers is empty: every discovered CLIProxy provider will drift-warn as unconfigured and no pool will route quota-aware.");
  }

  const providerWindows: Record<string, string[]> = { ...DEFAULT_PROVIDER_WINDOWS };
  const providerWindowsIn = r.providerWindows ?? {};
  if (isPlainObject(providerWindowsIn)) {
    for (const [provider, list] of Object.entries(providerWindowsIn)) {
      if (!Array.isArray(list) || !list.every((s) => typeof s === "string" && s)) {
        errors.push(`providerWindows[${provider}] must be a list of non-empty window substrings.`);
        continue;
      }
      const lowered = (list as string[]).map((s) => s.toLowerCase());
      if (lowered.length === 0 && DEFAULT_PROVIDER_WINDOWS[provider.toLowerCase()] !== undefined) {
        warnings.push(
          `providerWindows[${provider}] is empty: this converts a gated provider to quota-blind fail-open (routes without quota knowledge). Restore the defaults if that was not intended.`,
        );
      }
      if (provider.toLowerCase() === "codex" && lowered.length > 0) {
        // Stock Codex headers carry bare `primary` / `secondary` windows, and
        // gating is decided on those bare window names (not the `codex:…`
        // prefixed ids): an override of ["codex"] looks covering but gates
        // nothing, while ["5h", "weekly"] silently stops gating stock quota.
        // Probe the names gating actually sees so existing installations
        // are told to update instead of routing blind.
        const gates = (window: string) => lowered.some((sub) => sub !== "" && window.includes(sub));
        if (!gates("primary") || !gates("secondary")) {
          warnings.push(
            `providerWindows[codex] does not gate the stock primary/secondary windows; existing overrides need "primary" and "secondary" entries (or a matching substring) or stock Codex quota stops constraining routing.`,
          );
        }
      }
      providerWindows[provider.toLowerCase()] = lowered;
    }
  }

  // v2: one plugin quota route per provider (not per account). Each fetch
  // carries the credential's `auth_index` (required since CLIProxy v8.0.49),
  // so the fetched windows attach to their own account row — not to every
  // row of the provider — with the sync fetch time as their observation.
  // Entries without an `auth_index` (older builds) keep one provider-level
  // fetch. Failed quota fetches are best-effort and never spend strikes.
  const pluginQuotaIds: Record<string, string> = {};
  const pluginQuotaIdsIn = (r.pluginQuotaIds ?? {}) as Record<string, unknown>;
  if (isPlainObject(pluginQuotaIdsIn)) {
    for (const [provider, pluginId] of Object.entries(pluginQuotaIdsIn)) {
      if (typeof pluginId !== "string" || !pluginId) {
        errors.push(`pluginQuotaIds[${provider}] must be a non-empty CLIProxy plugin id.`);
        continue;
      }
      if (!SINGLE_SEGMENT.test(pluginId)) {
        errors.push(`pluginQuotaIds[${provider}] must be a single path segment; got ${JSON.stringify(pluginId)}.`);
        continue;
      }
      pluginQuotaIds[provider.toLowerCase()] = pluginId;
    }
  }

  // Per-provider kill switch for the pinned live `api-call` rounds. Keys are
  // lowercased provider words; values must be booleans. Missing entries fall
  // back to DEFAULT_LIVE_QUOTA_PROVIDERS (on for antigravity/devin/meta).
  const apiCallEnabled: Record<string, boolean> = {};
  const apiCallEnabledIn = (r.apiCallEnabled ?? {}) as Record<string, unknown>;
  if (isPlainObject(apiCallEnabledIn)) {
    for (const [provider, enabled] of Object.entries(apiCallEnabledIn)) {
      if (typeof enabled !== "boolean") {
        errors.push(`apiCallEnabled[${provider}] must be a boolean; got ${JSON.stringify(enabled)}.`);
        continue;
      }
      apiCallEnabled[provider.toLowerCase()] = enabled;
    }
  } else if (r.apiCallEnabled !== undefined) {
    errors.push("apiCallEnabled must be an object mapping provider words to booleans.");
  }

  const perPoolReservePercent: Record<string, number> = {};
  const perPoolIn = (r.perPoolReservePercent ?? {}) as Record<string, unknown>;
  if (isPlainObject(perPoolIn)) {
    for (const [poolId, value] of Object.entries(perPoolIn)) {
      if (typeof value !== "number" || !(value > 0 && value < 50)) {
        errors.push(`perPoolReservePercent[${poolId}] must be within (0, 50).`);
        continue;
      }
      perPoolReservePercent[poolId] = value;
    }
  }

  if (r.audienceConfirmed !== true) {
    warnings.push(
      "audienceConfirmed is not set: the plugin page shows upstream account quota state (providers, plan labels, per-account status). Confirm which company roles may view plugin pages and that the exposure is intended (proposal §4 point 4), then set audienceConfirmed: true.",
    );
  }

  // The management client uses pinned paths (see cliproxy.ts
  // AUTH_FILES_PATH / pluginQuotaPath) — there are deliberately no config
  // knobs for them. Unknown keys (including the removed v1 prefixMap,
  // authFilesPath / pluginQuotaPathTemplate / modelsPath) are ignored, never
  // honoured. A leftover v1 prefixMap errors loudly so the operator migrates
  // instead of running a dead map.
  if (r.prefixMap !== undefined) {
    errors.push(
      "prefixMap was removed in v2 (per-provider config replaces the per-account map). Delete prefixMap and add one providers[] row per CLIProxy provider instead.",
    );
  }
  const config: ConnectorConfig = {
    cliproxyBaseUrl,
    managementKeyHeader,
    managementSecretRef: r.managementSecretRef,
    clientApiKeySecretRef: r.clientApiKeySecretRef ?? null,
    syncIntervalMinutes,
    reservePercent,
    perPoolReservePercent,
    recheckSeconds: num(r.recheckSeconds, DEFAULTS.recheckSeconds),
    maxAgeMultiplier: num(r.maxAgeMultiplier, DEFAULTS.maxAgeMultiplier),
    graceMultiplier: num(r.graceMultiplier, DEFAULTS.graceMultiplier),
    futureSkewSeconds: num(r.futureSkewSeconds, DEFAULTS.futureSkewSeconds),
    providers,
    providerWindows,
    pluginQuotaIds,
    apiCallEnabled,
    audienceConfirmed: r.audienceConfirmed === true,
  };
  return { config, validation: { ok: errors.length === 0, warnings, errors } };
}

/**
 * Default per-provider live `api-call` state. On for the families with pinned
 * templates (antigravity/devin) and for meta (no template exists, so the entry
 * documents intent and covers a future Meta template without a config
 * migration); off for everything else, which has no template anyway. An
 * explicit `apiCallEnabled` entry always wins over this default.
 */
export const DEFAULT_LIVE_QUOTA_PROVIDERS: Record<string, boolean> = {
  antigravity: true,
  devin: true,
  meta: true,
};

/** Whether the pinned live `api-call` rounds may run for a provider family. */
export function isLiveQuotaEnabled(config: ConnectorConfig, provider: string): boolean {
  const word = provider.trim().toLowerCase();
  const explicit = config.apiCallEnabled[word];
  if (typeof explicit === "boolean") return explicit;
  return DEFAULT_LIVE_QUOTA_PROVIDERS[word] ?? false;
}

/**
 * Provider words with a dedicated quota parser (informational only — config
 * rows accept any provider string). Unknown words use the generic parser and
 * stay quota-blind. Kept exported for the plugin page's provider labels.
 */
const KNOWN_PROVIDER_WORDS = new Set([
  "claude",
  "codex",
  "devin",
  "meta",
  "antigravity",
  "xai",
  "kimi",
  "compat",
  "synthetic",
  "nvidia-nim",
  "openrouter",
  "cloudflare",
  "cloudflare-workers-ai",
  "zai",
  "opencode-go",
]);

export function isKnownProviderWord(provider: string): boolean {
  return KNOWN_PROVIDER_WORDS.has(provider.toLowerCase());
}

/**
 * Effective reserve for a pool (percent remaining that still routes).
 *
 * Precedence: per-pool plugin override → pool `thresholdPercent` derived
 * (`100 - thresholdPercent`, the #17007 semantics) → company default.
 * Never a hard `=== 90` gate: a pool without a usable threshold falls back
 * to the plugin default instead of refusing to route.
 */
export function effectiveReservePercent(
  config: ConnectorConfig,
  pool: { id?: string; thresholdPercent?: unknown },
): number {
  if (pool.id && typeof config.perPoolReservePercent[pool.id] === "number") {
    return config.perPoolReservePercent[pool.id] as number;
  }
  const t = pool.thresholdPercent;
  if (typeof t === "number" && Number.isFinite(t) && t > 50 && t < 100) {
    return 100 - t;
  }
  return config.reservePercent;
}

/** Freshness bound in ms: sync-relative (≥2× sync interval by default). */
export function maxAgeMs(config: ConnectorConfig): number {
  return config.syncIntervalMinutes * 60_000 * config.maxAgeMultiplier;
}

/** Fail-open grace window in ms: maxAge × graceMultiplier. */
export function graceMs(config: ConnectorConfig): number {
  return maxAgeMs(config) * config.graceMultiplier;
}
