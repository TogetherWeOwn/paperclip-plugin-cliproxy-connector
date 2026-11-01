import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "togetherweown.cliproxy-connector";
export const PLUGIN_VERSION = "0.2.2";
export const SYNC_JOB_KEY = "cliproxy-sync";
export const PAGE_DATA_KEY = "cliproxy-page";
export const WIDGET_DATA_KEY = "cliproxy-widget";
export const RESYNC_ACTION_KEY = "cliproxy-resync";
export const REENABLE_ACTION_KEY = "cliproxy-reenable";
export const STATE_NAMESPACE = "cliproxy-connector";
export const ROWS_STATE_KEY = "usage-rows";
export const LAST_SYNC_STATE_KEY = "last-sync";
export const STRIKE_STATE_KEY = "strike-budget";
/** Latest sync failure (non-auth errors, unresolvable secrets). Never touches `last-sync`. */
export const LAST_ERROR_STATE_KEY = "last-error";

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
  jobs: [
    {
      jobKey: SYNC_JOB_KEY,
      displayName: "Sync CLIProxy quota",
      description:
        "Discovers CLIProxy accounts per provider (auth-files) and per-provider quota (plugin quota routes) through the GET-only safe path into the plugin cache. Runs every 5 minutes; syncIntervalMinutes above 5 widens the freshness math rather than slowing the cron.",
      schedule: "*/5 * * * *",
    },
  ],
  apiRoutes: [
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
