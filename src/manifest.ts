import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { CONNECTOR_CONFIG_SCHEMA } from "./config.js";
import { DIAGNOSTICS_DECLARATION } from "./diagnostics.js";

export const PLUGIN_ID = "togetherweown.cliproxy-connector";
export const PLUGIN_VERSION = "0.3.0";
export const SYNC_JOB_KEY = "cliproxy-sync";
export const PAGE_DATA_KEY = "cliproxy-page";
export const USAGE_DATA_KEY = "cliproxy-usage";
export const WIDGET_DATA_KEY = "cliproxy-widget";
export const RESYNC_ACTION_KEY = "cliproxy-resync";
export const REENABLE_ACTION_KEY = "cliproxy-reenable";
export const STATE_NAMESPACE = "cliproxy-connector";
export const ROWS_STATE_KEY = "usage-rows";
export const LAST_SYNC_STATE_KEY = "last-sync";
export const STRIKE_STATE_KEY = "strike-budget";
/** Latest sync failure (non-auth errors, unresolvable secrets). Never touches `last-sync`. */
export const LAST_ERROR_STATE_KEY = "last-error";
/**
 * Last-known OpenRouter spend snapshot + soft failure note (see
 * `StoredSpend`). Written only by the spend read, read only by the usage
 * page builder. A failed fetch keeps the previous snapshot.
 */
export const SPEND_STATE_KEY = "provider-spend";
/**
 * Last-known per-provider request counts + soft failure note (see
 * `StoredRequestCounts`). Aggregated by provider in the worker — composite
 * `base_url|api_key` keys never reach this state. Written only by the
 * request-count read, read only by the usage page builder.
 */
export const REQUEST_COUNTS_STATE_KEY = "request-counts";
/**
 * Drift ledger for state-change activity logging: per drift key the first/last
 * seen times plus the last time it produced an activity row. New findings log
 * once, cleared findings log once, and persistent findings remind at most
 * daily.
 */
export const DRIFT_LEDGER_STATE_KEY = "drift-ledger";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "CLIProxy Provider Quota",
  description:
    "Discovers CLIProxy accounts per provider into a local cache and routes AI-connection pools quota-aware (usage_aware) with wait/resume. One config row per provider; missing data is unknown, never headroom.",
  author: "TogetherWeOwn",
  categories: ["automation"],
  capabilities: [
    "ai.connections.route",
    "jobs.schedule",
    "companies.read",
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "activity.log.write",
    "api.routes.register",
    "agent.tools.register",
    "ui.page.register",
    "ui.dashboardWidget.register",
  ],
  aiConnectionRouter: {
    name: "CLIProxy quota-aware router",
    description:
      "Aggregates per-provider quota from the plugin's CLIProxy sync cache and selects a member with headroom; returns exhausted with retryAt so core wait/resume fires. Never calls CLIProxy inline.",
  },
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: CONNECTOR_CONFIG_SCHEMA,
  jobs: [
    {
      jobKey: SYNC_JOB_KEY,
      displayName: "Sync CLIProxy quota",
      description:
        "Discovers CLIProxy accounts per provider (auth-files) and per-provider quota (plugin quota routes, the pinned provider-API templates for Antigravity and Devin with one call per account per run, and the Meta download + literal-header key call at most every 45 minutes per account plus manual refresh) through the pinned safe path into the plugin cache. Runs every 5 minutes with a one-minute minimum between syncs; syncIntervalMinutes controls freshness bounds only, not scheduler frequency.",
      schedule: "*/5 * * * *",
    },
  ],
  tools: [DIAGNOSTICS_DECLARATION],
  apiRoutes: [
    {
      routeKey: "diagnostics",
      method: "GET",
      path: "/diagnostics",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "reenable",
      method: "POST",
      path: "/setup/reenable",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: "cliproxy-accounts",
        displayName: "CLIProxy Accounts",
        exportName: "CliProxyPage",
      },
      {
        type: "page",
        id: "cliproxy-usage",
        displayName: "Usage & Quota",
        exportName: "CliProxyUsagePage",
      },
      {
        type: "dashboardWidget",
        id: "cliproxy-health",
        displayName: "CLIProxy Quota Health",
        exportName: "CliProxyWidget",
      },
    ],
  },
  minimumHostVersion: "2026.1023.0",
};

export default manifest;
