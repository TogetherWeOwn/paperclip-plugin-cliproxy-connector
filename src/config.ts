/**
 * Company-level connector configuration: parsing, validation and defaults.
 *
 * The host carries company config opaquely (`ctx.config.get(companyId)`), so
 * this module is the single place that turns it into a typed, validated
 * `ConnectorConfig`. Anything security-relevant (loopback base URL, explicit
 * key header, secret_ref shape) fails validation loudly here.
 */

export interface ConnectorConfig {
  /** Loopback-only CLIProxy base URL, e.g. `http://127.0.0.1:8317`. */
  cliproxyBaseUrl: string;
  /** Management-key header name, e.g. `X-Management-Key`. No silent default. */
  managementKeyHeader: string;
  /** Paperclip `secret_ref` object for the management key. Never persisted. */
  managementSecretRef: unknown;
  /** Sync cadence in minutes. The cron job runs every 5; larger values skip. */
  syncIntervalMinutes: number;
  /** Default reserve: members at or below this remaining % are skipped. */
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
  /** Operator map: CLIProxy prefix → Paperclip connection id. */
  prefixMap: Record<string, string>;
  /** Per-provider gating-window allow-list (lowercased substring match). */
  providerWindows: Record<string, string[]>;
  /** CLIProxy plugin id per prefix for quota fetch (our five plugins). */
  pluginQuotaIds: Record<string, string>;
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
  codex: ["codex", "5h", "weekly"],
  devin: ["devin", "5h", "weekly"],
  synthetic: ["weekly", "rolling-5h", "5h", "subscription"],
  "nvidia-nim": ["rpm", "minute"],
  cloudflare: ["daily", "neurons"],
  zai: ["5h", "weekly"],
  "opencode-go": ["rolling", "weekly", "monthly", "5h"],
};

/** Single path segment: no slashes, no dots, no encoding tricks. Shared with the management client. */
export const SINGLE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

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

export function parseConfig(raw: unknown): { config: ConnectorConfig; validation: ConfigValidation } {
  const warnings: string[] = [];
  const errors: string[] = [];
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;

  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;

  const cliproxyBaseUrl = str(r.cliproxyBaseUrl).trim().replace(/\/+$/, "");
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

  const reservePercent = num(r.reservePercent, DEFAULTS.reservePercent);
  if (!(reservePercent > 0 && reservePercent < 50)) {
    errors.push(`reservePercent must be within (0, 50); got ${reservePercent}.`);
  }
  const syncIntervalMinutes = num(r.syncIntervalMinutes, DEFAULTS.syncIntervalMinutes);
  if (!(syncIntervalMinutes >= 1 && syncIntervalMinutes <= 60)) {
    errors.push(`syncIntervalMinutes must be within [1, 60]; got ${syncIntervalMinutes}.`);
  }

  const prefixMapIn = (r.prefixMap ?? {}) as Record<string, unknown>;
  const prefixMap: Record<string, string> = {};
  const seenConnections = new Map<string, string>();
  if (typeof prefixMapIn !== "object" || prefixMapIn === null || Array.isArray(prefixMapIn)) {
    errors.push("prefixMap must be an object of CLIProxy prefix → Paperclip connection id.");
  } else {
    for (const [prefix, connectionId] of Object.entries(prefixMapIn)) {
      if (!SINGLE_SEGMENT.test(prefix)) {
        errors.push(`prefixMap key ${JSON.stringify(prefix)} is not a single path segment (no "/", must match [A-Za-z0-9_-]+).`);
        continue;
      }
      if (typeof connectionId !== "string" || !connectionId) {
        errors.push(`prefixMap[${prefix}] must be a non-empty connection id.`);
        continue;
      }
      prefixMap[prefix] = connectionId;
      const prev = seenConnections.get(connectionId);
      if (prev !== undefined && prev !== prefix) {
        warnings.push(
          `prefixMap: connection ${connectionId} is mapped from both ${prev} and ${prefix}; quota rows may be attributed ambiguously.`,
        );
      } else {
        seenConnections.set(connectionId, prefix);
      }
    }
  }
  if (Object.keys(prefixMap).length === 0) {
    warnings.push("prefixMap is empty: every CLIProxy account will drift-warn as unmapped until the operator fills the map.");
  }

  const providerWindows: Record<string, string[]> = { ...DEFAULT_PROVIDER_WINDOWS };
  const providerWindowsIn = (r.providerWindows ?? {}) as Record<string, unknown>;
  if (typeof providerWindowsIn === "object" && providerWindowsIn !== null) {
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
      providerWindows[provider.toLowerCase()] = lowered;
    }
  }

  const pluginQuotaIds: Record<string, string> = {};
  const pluginQuotaIdsIn = (r.pluginQuotaIds ?? {}) as Record<string, unknown>;
  if (typeof pluginQuotaIdsIn === "object" && pluginQuotaIdsIn !== null) {
    for (const [prefix, pluginId] of Object.entries(pluginQuotaIdsIn)) {
      if (typeof pluginId !== "string" || !pluginId) {
        errors.push(`pluginQuotaIds[${prefix}] must be a non-empty CLIProxy plugin id.`);
        continue;
      }
      pluginQuotaIds[prefix] = pluginId;
    }
  }

  const perPoolReservePercent: Record<string, number> = {};
  const perPoolIn = (r.perPoolReservePercent ?? {}) as Record<string, unknown>;
  if (typeof perPoolIn === "object" && perPoolIn !== null) {
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
      "audienceConfirmed is not set: the plugin page shows upstream account identity (emails/labels). Confirm which company roles may view plugin pages and that the exposure is intended (proposal §4 point 4), then set audienceConfirmed: true.",
    );
  }

  // NOTE: the management client uses pinned paths (see cliproxy.ts
  // AUTH_FILES_PATH / pluginQuotaPath) — there are deliberately no config
  // knobs for them. Unknown keys (including the removed authFilesPath /
  // pluginQuotaPathTemplate / modelsPath) are ignored, never honoured.
  const config: ConnectorConfig = {
    cliproxyBaseUrl,
    managementKeyHeader,
    managementSecretRef: r.managementSecretRef,
    syncIntervalMinutes,
    reservePercent,
    perPoolReservePercent,
    recheckSeconds: num(r.recheckSeconds, DEFAULTS.recheckSeconds),
    maxAgeMultiplier: num(r.maxAgeMultiplier, DEFAULTS.maxAgeMultiplier),
    graceMultiplier: num(r.graceMultiplier, DEFAULTS.graceMultiplier),
    futureSkewSeconds: num(r.futureSkewSeconds, DEFAULTS.futureSkewSeconds),
    prefixMap,
    providerWindows,
    pluginQuotaIds,
    audienceConfirmed: r.audienceConfirmed === true,
  };
  return { config, validation: { ok: errors.length === 0, warnings, errors } };
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
