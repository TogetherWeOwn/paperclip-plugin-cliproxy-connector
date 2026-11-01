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
import { parseConfig } from "./config.js";
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
  WIDGET_DATA_KEY,
} from "./manifest.js";
import { route, type RouterCandidate } from "./router.js";
import { emptyStrikeBudget, reenableAfterStrike, runSync } from "./sync.js";
import type { AccountUsageRow, StrikeBudgetState, SyncFailure, SyncSummary } from "./types.js";
import { buildPageData, buildWidgetData } from "./ui-data.js";

const inFlight: { running: boolean } = { running: false };

type StateKey = { scopeKind: "company"; scopeId: string; namespace: string; stateKey: string };

function key(companyId: string, stateKey: string): StateKey {
  return { scopeKind: "company", scopeId: companyId, namespace: STATE_NAMESPACE, stateKey };
}

async function loadStrike(ctx: PluginContext, companyId: string): Promise<StrikeBudgetState> {
  const raw = await ctx.state.get(key(companyId, STRIKE_STATE_KEY));
  if (raw !== null && typeof raw === "object") return raw as StrikeBudgetState;
  return emptyStrikeBudget();
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
    ctx.data.register(WIDGET_DATA_KEY, async (params) => {
      const companyId = String((params as Record<string, unknown>).companyId ?? "");
      const [config, rows, lastSync, strike, lastFailure] = await Promise.all([
        resolveCompany(ctx, companyId).then((r) => r.config),
        loadRows(ctx, companyId),
        loadLastSync(ctx, companyId),
        loadStrike(ctx, companyId),
        loadLastFailure(ctx, companyId),
      ]);
      return buildWidgetData({ now: new Date().toISOString(), config, rows, lastSync, strike, lastFailure });
    });

    ctx.actions.register(RESYNC_ACTION_KEY, async (params) => {
      const companyId = String((params as Record<string, unknown>).companyId ?? "");
      if (!companyId) throw new Error("companyId is required");
      return runCompanySync(ctx, companyId, new Date().toISOString());
    });
    ctx.actions.register(REENABLE_ACTION_KEY, async (params) => {
      const companyId = String((params as Record<string, unknown>).companyId ?? "");
      if (!companyId) throw new Error("companyId is required");
      const next = await reenableAfterStrike(
        () => loadStrike(ctx, companyId),
        (s) => ctx.state.set(key(companyId, STRIKE_STATE_KEY), s),
      );
      await ctx.activity.log({
        companyId,
        message: "cliproxy-connector: strike budget re-enabled by board action.",
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
      const next = await reenableAfterStrike(
        () => loadStrike(ctx, companyId),
        (s) => ctx.state.set(key(companyId, STRIKE_STATE_KEY), s),
      );
      await ctx.activity.log({
        companyId,
        message: "cliproxy-connector: strike budget re-enabled via board API route.",
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
  return runSync(
    {
      config,
      companyId,
      now,
      resolveSecret: (ref) => ctx.secrets.resolve(ref as never, { companyId }),
      fetchImpl: ctx.http.fetch.bind(ctx.http),
      loadStrike: () => loadStrike(ctx, companyId),
      saveStrike: (s) => ctx.state.set(key(companyId, STRIKE_STATE_KEY), s),
      loadRows: () => loadRows(ctx, companyId),
      loadLastSync: () => loadLastSync(ctx, companyId),
      saveSync: async (rows, result) => {
        await ctx.state.set(key(companyId, ROWS_STATE_KEY), rows);
        await ctx.state.set(key(companyId, LAST_SYNC_STATE_KEY), result);
      },
      recordFailure: async (failure) => {
        await ctx.state.set(key(companyId, LAST_ERROR_STATE_KEY), failure);
      },
      logActivity: (message, metadata) => ctx.activity.log({ companyId, message, metadata }),
    },
    inFlight,
  );
}

async function pageData(ctx: PluginContext, companyId: string, now: string) {
  const [config, rows, lastSync, strike, lastFailure] = await Promise.all([
    resolveCompany(ctx, companyId).then((r) => r.config),
    loadRows(ctx, companyId),
    loadLastSync(ctx, companyId),
    loadStrike(ctx, companyId),
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
    return {
      memberId: String(member.id ?? ""),
      model: String(member.profile?.model ?? ""),
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
  const rows = new Map<string, AccountUsageRow>(Object.entries(await loadRows(ctx, params.companyId)));
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
