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
