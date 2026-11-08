import { aggregateProvider } from "./aggregate.js";
import { effectiveReservePercent, providerConnectionIds, type ConnectorConfig } from "./config.js";
import type { AccountUsageRow } from "./types.js";

export const DIAGNOSTICS_TOOL = "quota-diagnostics";
export const DIAGNOSTICS_DECLARATION = {
  name: DIAGNOSTICS_TOOL,
  displayName: "Explain cached CLIProxy quota",
  description: "Read-only cached quota assessment for one configured connection in your company. Optional pool ID/threshold/model are caller-supplied assessment inputs, not a readback of native pool settings. Never probes providers or changes routing.",
  parametersSchema: {
    type: "object",
    additionalProperties: false,
    required: ["connectionId"],
    properties: {
      connectionId: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" },
      poolId: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" },
      thresholdPercent: { type: "integer", minimum: 1, maximum: 100 },
      model: { type: "string", minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$" },
    },
  },
} as const;

export interface DiagnosticsParams {
  connectionId: string;
  poolId?: string;
  thresholdPercent?: number;
  model?: string;
}

/** The worker validates again; host/model schema validation is not a boundary. */
export function parseDiagnosticsParams(value: unknown): DiagnosticsParams | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (Object.keys(o).some((k) => !["connectionId", "poolId", "thresholdPercent", "model"].includes(k))) return null;
  const id = (v: unknown) => typeof v === "string" && v.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(v);
  if (!id(o.connectionId) || (o.poolId !== undefined && !id(o.poolId))) return null;
  if (o.thresholdPercent !== undefined && (typeof o.thresholdPercent !== "number" || !Number.isInteger(o.thresholdPercent) || o.thresholdPercent < 1 || o.thresholdPercent > 100)) return null;
  if (o.model !== undefined && (typeof o.model !== "string" || o.model.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(o.model))) return null;
  return {
    connectionId: o.connectionId as string,
    ...(o.poolId !== undefined ? { poolId: o.poolId as string } : {}),
    ...(o.thresholdPercent !== undefined ? { thresholdPercent: o.thresholdPercent as number } : {}),
    ...(o.model !== undefined ? { model: o.model as string } : {}),
  };
}

/** Bound the trusted configuration too before its general parser traverses it. */
export function diagnosticsConfigWithinBounds(value: unknown): boolean {
  let nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > 20_000 || depth > 8) return false;
    if (typeof item === "string") return item.length <= 2000;
    if (item === null || typeof item !== "object") return true;
    if (Array.isArray(item)) return item.length <= 2000 && item.every((child) => visit(child, depth + 1));
    let keys = 0;
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      keys += 1;
      if (keys > 2000 || key.length > 256 || !visit((item as Record<string, unknown>)[key], depth + 1)) return false;
    }
    return true;
  };
  return visit(value, 0);
}

/** Bound nested work before invoking aggregation on host-owned cached JSON. */
export function diagnosticsCacheWithinBounds(rows: AccountUsageRow[]): boolean {
  if (rows.length > 2000) return false;
  let limits = 0;
  let models = 0;
  const short = (v: unknown, max: number) => v == null || (typeof v === "string" && v.length <= max);
  for (const row of rows) {
    if (!row || !short(row.provider, 128) || !short(row.checkedAt, 40) || !Array.isArray(row.limits) || row.limits.length > 256) return false;
    limits += row.limits.length;
    if (limits > 10_000) return false;
    for (const limit of row.limits) {
      if (!limit || !short(limit.id, 256) || !short(limit.observedAt, 40) || !short(limit.resetsAt, 40)) return false;
      if (limit.models != null) {
        if (!Array.isArray(limit.models) || limit.models.length > 100) return false;
        models += limit.models.length;
        if (models > 20_000 || limit.models.some((model) => typeof model !== "string" || model.length > 200)) return false;
      }
    }
  }
  return true;
}

/** Same aggregate and reserve precedence as routing; no secrets or raw cache projection. */
export function buildDiagnostics(config: ConnectorConfig, rows: AccountUsageRow[], params: DiagnosticsParams, now: string) {
  const provider = config.providers.find((p) => providerConnectionIds(p).includes(params.connectionId));
  if (!provider) return null;
  const assessment = aggregateProvider({
    provider: provider.provider, model: params.model ?? null, rows,
    completeInventory: provider.completeInventory,
    creditsCountAsHeadroom: provider.creditsCountAsHeadroom,
    config, now, poolId: params.poolId, poolThresholdPercent: params.thresholdPercent,
  });
  return {
    checkedAt: now,
    source: "connector-cache",
    assessmentInputs: {
      connectionId: params.connectionId,
      poolId: params.poolId ?? null,
      thresholdPercent: params.thresholdPercent ?? null,
      model: params.model ?? null,
      nativePoolReadback: false,
    },
    reservePercent: effectiveReservePercent(config, { id: params.poolId, thresholdPercent: params.thresholdPercent }),
    assessment,
  };
}
