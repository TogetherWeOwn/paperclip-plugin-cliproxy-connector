export { default as manifest, PLUGIN_ID, SYNC_JOB_KEY, USAGE_DATA_KEY } from "./manifest.js";
export { default as plugin, routeWithCache, toRouterCandidates } from "./plugin.js";
export type {
  AccountUsageRow,
  SyncFailure,
  SyncSummary,
  DriftFinding,
  DriftLedger,
  DriftLedgerEntry,
  StrikeBudgetState,
  ModelOverlap,
} from "./types.js";
export {
  deriveProviderModels,
  namespaceOfModelId,
  observedModelKeysByProvider,
  parseModelsPayload,
} from "./models.js";
export type { ServedModel } from "./models.js";
export { CliproxyClientApiClient, MODELS_PATH } from "./cliproxy.js";
export { stripProviderNamespace } from "./aggregate.js";
export { route, resolveProviderRow, detectMissingConnections } from "./router.js";
export { aggregateProvider } from "./aggregate.js";
export {
  runSync,
  reenableAfterStrike,
  accountsToRows,
  strikeWaitUntil,
  reconcileDriftLedger,
  logSyncFailure,
  driftKeyFor,
  ACTIVITY_DRIFT_DETECTED,
  ACTIVITY_DRIFT_CLEARED,
  ACTIVITY_DRIFT_REMINDER,
  ACTIVITY_SYNC_FAILED,
  ACTIVITY_SYNC_RECOVERED,
  ACTIVITY_STRIKE_REENABLED,
  ACTIVITY_REMINDER_INTERVAL_MS,
} from "./sync.js";
export { parseConfig, effectiveReservePercent } from "./config.js";
