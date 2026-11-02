/**
 * Plugin worker wiring: sync job, router hook, UI data/actions, health.
 *
 * The worker never holds upstream credentials and never sees the management
 * key except as a transient string inside a single sync run (resolved per run
 * via `secrets.read-ref`, kept in memory only, never persisted or logged).
 */
import type { AiConnectionRouterRequest, AiConnectionRouterResult } from "@paperclipai/shared";
import { definePlugin } from "@paperclipai/plugin-sdk";
import type {
  PluginApiRequestInput,
  PluginApiResponse,
  PluginContext,
} from "@paperclipai/plugin-sdk";
import { parseConfig, stripTrailingSlashes, type ConnectorConfig } from "./config.js";
import { createLoopbackFetch } from "./loopback-fetch.js";
import {
  LAST_ERROR_STATE_KEY,
  LAST_SYNC_STATE_KEY,
  PAGE_DATA_KEY,
  REENABLE_ACTION_KEY,
  RESYNC_ACTION_KEY,
  ROWS_STATE_KEY,
  STATE_NAMESPACE,
  STRIKE_STATE_KEY,
  SYNC_JOB_KEY,
  USAGE_DATA_KEY,
  WIDGET_DATA_KEY,
} from "./manifest.js";
import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { route, type RouterCandidate } from "./router.js";
import { emptyStrikeBudget, reenableAfterStrike, runSync, type ApiCallCachedEnvelope } from "./sync.js";
import type { AccountUsageRow, StrikeBudgetState, SyncFailure, SyncSummary } from "./types.js";
import { buildPageData, buildUsageData, buildWidgetData } from "./ui-data.js";

const inFlight: { running: boolean } = { running: false };

/**
 * Worker-level last provider-API call time per CLIProxy origin + credential
 * `auth_index` (epoch millis), plus the last 2xx answer per origin + index +
 * template. Bounds credential-bearing live quota reads to at most one
 * subscription round per account per throttle window across back-to-back
 * resyncs and across companies on the same CLIProxy; a throttled run reuses
 * the cached answers with their original observation times instead of
 * blanking the live windows. The scheduled 5-minute cadence never trips the
 * 4-minute bound. In memory only, never
 * persisted or logged.
 */
const apiCallLastCall = new Map<string, number>();
const apiCallCache = new Map<string, ApiCallCachedEnvelope>();
// Per-account upstream-auth backoff (origin + index → resume epoch millis)
// after a provider-side 401/403, plus the remembered working Antigravity
// quota URL per account. Same worker-owned, in-memory-only lifetime as the
// throttle maps above: a restart drops backoffs so install → resync → verify
// re-proves the endpoint instead of inheriting a stale ban.
const apiCallAuthBackoffUntil = new Map<string, number>();
const apiCallQuotaChoice = new Map<string, string>();

type CompanyStateKey = { scopeKind: "company"; scopeId: string; namespace: string; stateKey: string };
type InstanceStateKey = { scopeKind: "instance"; namespace: string; stateKey: string };

function key(companyId: string, stateKey: string): CompanyStateKey {
  return { scopeKind: "company", scopeId: companyId, namespace: STATE_NAMESPACE, stateKey };
}

/**
 * Normalise a CLIProxy base URL to its loopback port for strike-budget keying.
 * The CLIProxy lockout (5 bad keys = 30 min ban) is host-wide per origin, so
 * every company pointing at the same CLIProxy draws from ONE budget — and
 * every loopback spelling of that CLIProxy (`127.0.0.1`, `localhost`, `::1`)
 * must share it. Keying on the effective port (not the host string) gives one
 * bucket per local CLIProxy whatever the spelling.
 */
export function normaliseStrikeOrigin(cliproxyBaseUrl: string): string {
  try {
    const url = new URL(cliproxyBaseUrl);
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return `loopback:${port}`;
  } catch {
    return `loopback:${stripTrailingSlashes(cliproxyBaseUrl.trim())}`;
  }
}

/** Pre-port-migration key format (`https://host:port` origin strings). Adopted once, then deleted. */
function legacyOriginKey(origin: string): InstanceStateKey {
  return { scopeKind: "instance", namespace: STATE_NAMESPACE, stateKey: `${STRIKE_STATE_KEY}:${origin}` };
}

function strikeKey(bucket: string): InstanceStateKey {
  return { scopeKind: "instance", namespace: STATE_NAMESPACE, stateKey: `${STRIKE_STATE_KEY}:${bucket}` };
}

function isStrikeBudget(raw: unknown): raw is StrikeBudgetState {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}

async function loadStrike(
  ctx: PluginContext,
  companyId: string,
  bucket: string,
  origin: string,
): Promise<StrikeBudgetState> {
  const raw = await ctx.state.get(strikeKey(bucket));
  if (isStrikeBudget(raw)) return raw;
  // One-time adoption of the pre-port-key origin-format key: carry a spent
  // budget forward so the keying migration cannot reset it and allow extra
  // probes. The legacy key is deleted after adoption.
  const legacyOrigin = await ctx.state.get(legacyOriginKey(origin));
  if (isStrikeBudget(legacyOrigin)) {
    await ctx.state.set(strikeKey(bucket), legacyOrigin);
    try {
      await ctx.state.delete(legacyOriginKey(origin));
    } catch {
      /* best-effort: the legacy key is never read again once adopted */
    }
    return legacyOrigin;
  }
  // One-time adoption of the pre-host-wide-budget company-scoped key: same
  // carry-forward, then delete.
  const legacy = await ctx.state.get(key(companyId, STRIKE_STATE_KEY));
  if (isStrikeBudget(legacy)) {
    await ctx.state.set(strikeKey(bucket), legacy);
    try {
      await ctx.state.delete(key(companyId, STRIKE_STATE_KEY));
    } catch {
      /* best-effort: the legacy key is never read again once adopted */
    }
    return legacy;
  }
  return emptyStrikeBudget();
}

async function saveStrike(ctx: PluginContext, origin: string, s: StrikeBudgetState): Promise<void> {
  await ctx.state.set(strikeKey(origin), s);
}

function strikeOriginFor(config: ConnectorConfig): string {
  return normaliseStrikeOrigin(config.cliproxyBaseUrl);
}

/** Pre-port-migration origin string for one-time key adoption. */
function legacyOriginFor(config: ConnectorConfig): string {
  try {
    return new URL(config.cliproxyBaseUrl).origin;
  } catch {
    return stripTrailingSlashes(config.cliproxyBaseUrl.trim());
  }
}

async function loadRows(ctx: PluginContext, companyId: string): Promise<Record<string, AccountUsageRow>> {
  const raw = await ctx.state.get(key(companyId, ROWS_STATE_KEY));
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, AccountUsageRow>;
  }
  return {};
}

async function loadLastSync(ctx: PluginContext, companyId: string): Promise<SyncSummary | null> {
  const raw = await ctx.state.get(key(companyId, LAST_SYNC_STATE_KEY));
  if (raw !== null && typeof raw === "object") return raw as SyncSummary;
  return null;
}

async function loadLastFailure(ctx: PluginContext, companyId: string): Promise<SyncFailure | null> {
  const raw = await ctx.state.get(key(companyId, LAST_ERROR_STATE_KEY));
  if (raw !== null && typeof raw === "object") return raw as SyncFailure;
  return null;
}

async function resolveCompany(
  ctx: PluginContext,
  companyId: string,
): Promise<{ config: ReturnType<typeof parseConfig>["config"]; ok: boolean }> {
  const raw = await ctx.config.get(companyId);
  const { config, validation } = parseConfig(raw);
  return { config, ok: validation.ok };
}

let boundCtx: PluginContext | null = null;

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    boundCtx = ctx;
    // The scheduler runs this job without a company scope, so the job
    // iterates every visible company itself (decision-notifier pattern).
    // Per-company failures never abort the loop.
    ctx.jobs.register(SYNC_JOB_KEY, async () => {
      let companies: Array<{ id: string }>;
      try {
        companies = await ctx.companies.list();
      } catch (err) {
        ctx.logger?.warn?.(
          `cliproxy-connector: could not list companies for sync: ${err instanceof Error ? err.message : "unknown error"}`,
        );
        return;
      }
      for (const company of companies) {
        try {
          await runCompanySync(ctx, company.id, new Date().toISOString());
        } catch (err) {
          ctx.logger?.warn?.(
            `cliproxy-connector: sync failed for company ${company.id}: ${err instanceof Error ? err.message : "unknown error"}`,
          );
        }
      }
    });

    ctx.data.register(PAGE_DATA_KEY, async (params) => {
      const companyId = String((params as Record<string, unknown>).companyId ?? "");
      return pageData(ctx, companyId, new Date().toISOString());
    });
    // "Usage & quota" page: same sync cache, usage-shaped. Read-only —
    // the destructive usage-queue endpoint is never called.
    ctx.data.register(USAGE_DATA_KEY, async (params) => {
      const companyId = String((params as Record<string, unknown>).companyId ?? "");
      const config = await resolveCompany(ctx, companyId).then((r) => r.config);
      const [rows, lastSync, lastFailure] = await Promise.all([
        loadRows(ctx, companyId),
        loadLastSync(ctx, companyId),
        loadLastFailure(ctx, companyId),
      ]);
      return buildUsageData({ now: new Date().toISOString(), config, rows, lastSync, lastFailure });
    });
    ctx.data.register(WIDGET_DATA_KEY, async (params) => {
      const companyId = String((params as Record<string, unknown>).companyId ?? "");
      const config = await resolveCompany(ctx, companyId).then((r) => r.config);
      const origin = strikeOriginFor(config);
      const legacyOrigin = legacyOriginFor(config);
      const [rows, lastSync, strike, lastFailure] = await Promise.all([
        loadRows(ctx, companyId),
        loadLastSync(ctx, companyId),
        loadStrike(ctx, companyId, origin, legacyOrigin),
        loadLastFailure(ctx, companyId),
      ]);
      return buildWidgetData({ now: new Date().toISOString(), config, rows, lastSync, strike, lastFailure });
    });

    ctx.actions.register(RESYNC_ACTION_KEY, async (params) => {
      const companyId = String((params as Record<string, unknown>).companyId ?? "");
      if (!companyId) throw new Error("companyId is required");
      return runCompanySync(ctx, companyId, new Date().toISOString());
    });
    ctx.actions.register(REENABLE_ACTION_KEY, async (params, context?: PluginPerformActionContext) => {
      // Board users only: the host passes the authenticated actor — an agent
      // or system caller must never clear the hard stop. The company scope
      // comes from the host-authorised context, never from caller params.
      if (context?.actor?.type !== "user") {
        throw new Error(
          "cliproxy-reenable is a board-user action: re-enabling the strike budget requires an authenticated board user.",
        );
      }
      const companyId = context?.companyId;
      void params;
      if (!companyId) throw new Error("companyId is required (host-authorised action context).");
      const userId = context?.actor?.userId ?? "unknown";
      const { config } = await resolveCompany(ctx, companyId);
      const origin = strikeOriginFor(config);
      const legacyOrigin = legacyOriginFor(config);
      const next = await reenableAfterStrike(
        () => loadStrike(ctx, companyId, origin, legacyOrigin),
        (s) => saveStrike(ctx, origin, s),
        new Date().toISOString(),
      );
      await ctx.activity.log({
        companyId,
        message: `cliproxy-connector: strike budget re-enabled by board user ${userId}.`,
      });
      return next;
    });
  },

  async onRouteAiConnection(params: AiConnectionRouterRequest): Promise<AiConnectionRouterResult> {
    if (!boundCtx) {
      return {
        kind: "unavailable",
        skipped: { "pool:unknown": "router worker is not ready; refusing to guess." },
      };
    }
    return routeWithCache(boundCtx, params);
  },

  async onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
    if (input.routeKey === "reenable") {
      const body = (input.body ?? {}) as Record<string, unknown>;
      const companyId = String(body.companyId ?? input.companyId ?? "");
      if (!companyId) return { status: 400, body: { error: "companyId is required" } };
      if (!boundCtx) return { status: 503, body: { error: "worker is not ready" } };
      const ctx = boundCtx;
      const { config } = await resolveCompany(ctx, companyId);
      const origin = strikeOriginFor(config);
      const legacyOrigin = legacyOriginFor(config);
      const next = await reenableAfterStrike(
        () => loadStrike(ctx, companyId, origin, legacyOrigin),
        (s) => saveStrike(ctx, origin, s),
        new Date().toISOString(),
      );
      const actorLabel =
        input.actor.actorType === "user"
          ? `board user ${input.actor.userId ?? "unknown"}`
          : `agent ${input.actor.agentId ?? "unknown"}`;
      await ctx.activity.log({
        companyId,
        message: `cliproxy-connector: strike budget re-enabled via board API route by ${actorLabel}.`,
      });
      return { status: 200, body: { strike: next } };
    }
    return { status: 404, body: { error: `unknown route ${input.routeKey}` } };
  },

  async onValidateConfig(config: unknown) {
    const { validation } = parseConfig(config);
    return { ok: validation.ok, warnings: validation.warnings, errors: validation.errors };
  },

  async onHealth() {
    return { status: "ok" as const };
  },
});

async function runCompanySync(
  ctx: PluginContext,
  companyId: string,
  now: string,
): Promise<SyncSummary> {
  const { config, ok } = await resolveCompany(ctx, companyId);
  if (!ok) {
    const result: SyncSummary = {
      startedAt: now,
      finishedAt: new Date().toISOString(),
      accountsSeen: 0,
      rowsWritten: 0,
      drift: [],
      errors: ["company config is invalid; fix it on the plugin settings page."],
      skipped: true,
      skipReason: "company config is invalid; fix it on the plugin settings page.",
    };
    // Persist the skipped summary (keeping existing rows) so the plugin page
    // surfaces the config error instead of stale "no sync has run yet".
    await ctx.state.set(key(companyId, ROWS_STATE_KEY), await loadRows(ctx, companyId));
    await ctx.state.set(key(companyId, LAST_SYNC_STATE_KEY), result);
    return result;
  }
  // Host-wide budget: every company targeting the same CLIProxy origin draws
  // from one instance-scoped bucket (the CLIProxy lockout bans the host).
  const origin = strikeOriginFor(config);
  const legacyOrigin = legacyOriginFor(config);
  return runSync(
    {
      config,
      companyId,
      now,
      resolveSecret: (ref) => ctx.secrets.resolve(ref as never, { companyId }),
      // Same per-run, never-persisted rule as the management key: both
      // secrets resolve inside the sync run and live in memory only.
      resolveClientSecret: (ref) => ctx.secrets.resolve(ref as never, { companyId }),
      // Worker-local loopback transport, not `ctx.http.fetch`: the host runs
      // every plugin fetch through its SSRF guard, which refuses loopback —
      // but this plugin requires a loopback `cliproxyBaseUrl`, so the host
      // client can never reach it (TWO-749). The SDK allows direct Node fetch;
      // the transport re-guards it (loopback-only, exact origin, GET-only,
      // no auto-redirects) and every §4 rule above it is unchanged.
      fetchImpl: createLoopbackFetch(config.cliproxyBaseUrl),
      loadStrike: () => loadStrike(ctx, companyId, origin, legacyOrigin),
      saveStrike: (s) => saveStrike(ctx, origin, s),
      loadRows: () => loadRows(ctx, companyId),
      loadLastSync: () => loadLastSync(ctx, companyId),
      saveSync: async (rows, result) => {
        await ctx.state.set(key(companyId, ROWS_STATE_KEY), rows);
        await ctx.state.set(key(companyId, LAST_SYNC_STATE_KEY), result);
      },
      recordFailure: async (failure) => {
        // The host's `plugin_state` insert rejects a null `value_json`, so a
        // cleared failure must delete the key — never `set` null (a clean
        // sync would otherwise report "sync failed" on the page).
        if (failure === null) {
          await ctx.state.delete(key(companyId, LAST_ERROR_STATE_KEY));
        } else {
          await ctx.state.set(key(companyId, LAST_ERROR_STATE_KEY), failure);
        }
      },
      logActivity: (message, metadata) => ctx.activity.log({ companyId, message, metadata }),
      apiCallLastCall,
      apiCallCache,
      apiCallAuthBackoffUntil,
      apiCallQuotaChoice,
    },
    inFlight,
  );
}

async function pageData(ctx: PluginContext, companyId: string, now: string) {
  const config = await resolveCompany(ctx, companyId).then((r) => r.config);
  const origin = strikeOriginFor(config);
  const legacyOrigin = legacyOriginFor(config);
  const [rows, lastSync, strike, lastFailure] = await Promise.all([
    loadRows(ctx, companyId),
    loadLastSync(ctx, companyId),
    loadStrike(ctx, companyId, origin, legacyOrigin),
    loadLastFailure(ctx, companyId),
  ]);
  return buildPageData({ now, config, rows, lastSync, strike, lastFailure });
}

export function toRouterCandidates(
  params: AiConnectionRouterRequest,
): { candidates: RouterCandidate[]; poolId: string; poolMode: string; poolThresholdPercent: unknown } {
  const pool = (params.pool ?? {}) as {
    id?: string;
    mode?: string;
    thresholdPercent?: unknown;
  };
  const candidates = (params.candidates ?? []).map((c) => {
    const member = (c.member ?? {}) as {
      id?: string;
      profile?: { model?: string };
      binding?: { connectionId?: string };
    };
    const binding = (member.binding ?? {}) as { connectionId?: string };
    const runtime = (c.runtimeConfig ?? {}) as { model?: unknown };
    // Requested model: the task's runtime model wins (per-model quota where
    // CLIProxy reports it), falling back to the member profile model.
    const requested =
      typeof runtime.model === "string" && runtime.model ? runtime.model : member.profile?.model;
    return {
      memberId: String(member.id ?? ""),
      model: typeof requested === "string" ? requested : "",
      connectionId:
        typeof binding.connectionId === "string" && binding.connectionId ? binding.connectionId : null,
    };
  });
  return {
    candidates,
    poolId: String(pool.id ?? ""),
    poolMode: String(pool.mode ?? ""),
    poolThresholdPercent: pool.thresholdPercent,
  };
}

export async function routeWithCache(
  ctx: PluginContext,
  params: AiConnectionRouterRequest,
): Promise<AiConnectionRouterResult> {
  const { config } = await resolveCompany(ctx, params.companyId);
  const rows = Object.values(await loadRows(ctx, params.companyId));
  const { candidates, poolId, poolMode, poolThresholdPercent } = toRouterCandidates(params);
  return route({
    now: params.now,
    poolId,
    poolMode,
    poolThresholdPercent,
    memberOrder: params.memberOrder ?? [],
    lastMemberId: params.lastMemberId ?? null,
    pinnedMemberId: params.pinnedMemberId,
    candidates,
    rows,
    config,
  });
}

export default plugin;
