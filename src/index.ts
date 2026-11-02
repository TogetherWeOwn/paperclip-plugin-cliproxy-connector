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
  ProviderSpend,
  StoredSpend,
  ProviderRequestCounts,
  RequestBucket,
  StoredRequestCounts,
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
  activityKeyForFailureKind,
  driftKeyFor,
  ACTIVITY_DRIFT_DETECTED,
  ACTIVITY_DRIFT_CLEARED,
  ACTIVITY_DRIFT_STILL_PRESENT,
  ACTIVITY_SYNC_FAILED,
  ACTIVITY_SYNC_RECOVERED,
  ACTIVITY_SETUP_ERROR,
  ACTIVITY_STRIKE_BUDGET_REENABLED,
  ACTIVITY_REMINDER_INTERVAL_MS,
} from "./sync.js";
export { parseConfig, effectiveReservePercent } from "./config.js";
export {
  fetchOpenRouterCredits,
  parseOpenRouterCredits,
  OPENROUTER_CREDITS_URL,
  OPENROUTER_HOST,
  OpenRouterBodyError,
} from "./openrouter.js";
export type { OpenRouterFetch } from "./openrouter.js";
export { parseApiKeyUsage, RequestCountsBodyError } from "./request-counts.js";
