import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest, {
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
import plugin, { routeWithCache, toRouterCandidates } from "./plugin.js";
import type { AccountUsageRow } from "./types.js";

const COMPANY = "co-1";
const KEY = "HARNESS-KEY-MATERIAL-zzz";

const COMPANY_CONFIG = {
  cliproxyBaseUrl: "http://127.0.0.1:8317",
  managementKeyHeader: "X-Test-Key",
  managementSecretRef: { uid: "secret-1" },
  prefixMap: { "acct-claude-1": "conn-a1" },
  audienceConfirmed: true,
};

function stateKey(stateKey: string) {
  return { scopeKind: "company" as const, scopeId: COMPANY, namespace: STATE_NAMESPACE, stateKey };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch() {
  return vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname === "/v0/management/auth-files") {
      return jsonResponse(200, [
        {
          prefix: "acct-claude-1",
          channel: "claude",
          quota: {
            observed_at: "2026-11-01T12:00:00.000Z",
            signals: [{ window: "5h", usedPercent: 20 }],
          },
        },
      ]);
    }
    return new Response("not found", { status: 404 });
  });
}

async function setup(config: Record<string, unknown> = COMPANY_CONFIG) {
  const harness = createTestHarness({ manifest, config });
  harness.seed({ companies: [{ id: COMPANY }] as never });
  await plugin.definition.setup(harness.ctx);
  harness.ctx.secrets.resolve = (async () => KEY) as never;
  harness.ctx.http.fetch = mockFetch() as never;
  return harness;
}

describe("sync job", () => {
  it("writes usage rows and a sync summary to plugin state", async () => {
    const harness = await setup();
    await harness.runJob(SYNC_JOB_KEY);
    const rows = harness.getState(stateKey(ROWS_STATE_KEY)) as Record<string, AccountUsageRow>;
    expect(rows["acct-claude-1"].quotaBlind).toBe(false);
    expect(rows["acct-claude-1"].connectionId).toBe("conn-a1");
    const summary = harness.getState(stateKey(LAST_SYNC_STATE_KEY)) as { skipped: boolean };
    expect(summary.skipped).toBe(false);
  });

  it("skips without probing when the company config is invalid", async () => {
    const harness = await setup({ cliproxyBaseUrl: "https://x.example" });
    const fetch = harness.ctx.http.fetch as unknown as ReturnType<typeof mockFetch>;
    await harness.runJob(SYNC_JOB_KEY);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("persists the skipped summary so the page surfaces the config error", async () => {
    const harness = await setup({ cliproxyBaseUrl: "https://x.example" });
    await harness.runJob(SYNC_JOB_KEY);
    const summary = harness.getState(stateKey(LAST_SYNC_STATE_KEY)) as { skipped: boolean; errors: string[] };
    expect(summary.skipped).toBe(true);
    expect(summary.errors[0]).toMatch(/company config is invalid/);
  });

  it("serves page and widget data from the cache", async () => {
    const harness = await setup();
    await harness.runJob(SYNC_JOB_KEY);
    const page = await harness.getData<{ accounts: Array<{ prefix: string }> }>(PAGE_DATA_KEY, {
      companyId: COMPANY,
    });
    expect(page.accounts.map((a) => a.prefix)).toEqual(["acct-claude-1"]);
    const widget = await harness.getData<{ status: string }>(WIDGET_DATA_KEY, { companyId: COMPANY });
    expect(widget.status).toBe("healthy");
  });

  it("resync action re-runs the sync; re-enable action clears strikes", async () => {
    const harness = await setup();
    const summary = await harness.performAction<{ skipped: boolean }>(
      RESYNC_ACTION_KEY,
      {},
      { companyId: COMPANY },
    );
    expect(summary.skipped).toBe(false);
    const strike = await harness.performAction<{ disabled: boolean }>(
      REENABLE_ACTION_KEY,
      {},
      { companyId: COMPANY },
    );
    expect(strike.disabled).toBe(false);
  });
});

describe("config validation and health", () => {
  it("accepts the connector config and rejects insecure ones", async () => {
    const harness = await setup();
    void harness;
    expect(await plugin.definition.onValidateConfig!(COMPANY_CONFIG)).toMatchObject({ ok: true });
    const bad = await plugin.definition.onValidateConfig!({
      ...COMPANY_CONFIG,
      cliproxyBaseUrl: "https://cliproxy.example.com",
    });
    expect(bad.ok).toBe(false);
    expect((bad.errors ?? []).length).toBeGreaterThan(0);
  });

  it("reports ok health", async () => {
    await setup();
    expect(await plugin.definition.onHealth!()).toEqual({ status: "ok" });
  });
});

describe("board re-enable API route", () => {
  it("clears a spent strike budget and rejects unknown routes", async () => {
    const harness = await setup();
    const strikeKey = { ...stateKey(STRIKE_STATE_KEY), namespace: "cliproxy-connector" };
    harness.ctx.state.set(strikeKey as never, {
      failures: ["2026-11-01T12:00:00.000Z"],
      disabled: true,
      disabledAt: "2026-11-01T12:00:00.000Z",
      disabledReason: "spent",
      secretBad: true,
    } as never);
    const res = await plugin.definition.onApiRequest!({
      routeKey: "reenable",
      method: "POST",
      path: "/reenable",
      params: {},
      query: {},
      body: { companyId: COMPANY },
      actor: { actorType: "user", actorId: "u-1" },
      companyId: COMPANY,
      headers: {},
    });
    expect(res.status).toBe(200);
    expect((res.body as { strike: { disabled: boolean } }).strike.disabled).toBe(false);

    const unknown = await plugin.definition.onApiRequest!({
      routeKey: "nope",
      method: "GET",
      path: "/nope",
      params: {},
      query: {},
      body: null,
      actor: { actorType: "user", actorId: "u-1" },
      companyId: COMPANY,
      headers: {},
    });
    expect(unknown.status).toBe(404);
  });
});

describe("router glue", () => {
  it("maps host pool candidates to pinned candidates", () => {
    const { candidates, poolId, poolMode, poolThresholdPercent } = toRouterCandidates({
      companyId: COMPANY,
      pool: { id: "pool-1", mode: "usage_aware", thresholdPercent: 90 },
      candidates: [
        {
          member: {
            id: "m-a",
            profile: { model: "acct-claude-1/claude-sonnet-5" },
            binding: { connectionId: "conn-a1" },
          },
        },
      ],
    } as never);
    expect(poolId).toBe("pool-1");
    expect(poolMode).toBe("usage_aware");
    expect(poolThresholdPercent).toBe(90);
    expect(candidates).toEqual([{ memberId: "m-a", model: "acct-claude-1/claude-sonnet-5", connectionId: "conn-a1" }]);
  });

  it("routeWithCache selects a healthy member from cached rows", async () => {
    const ctx = {
      config: { get: async () => COMPANY_CONFIG },
      state: {
        get: async () =>
          ({
            "acct-claude-1": {
              prefix: "acct-claude-1",
              connectionId: "conn-a1",
              provider: "claude",
              poolFamily: "unknown",
              limits: [
                {
                  id: "claude:5h",
                  label: "5h",
                  usedPercent: 20,
                  remainingPercent: 80,
                  resetsAt: null,
                  limitReached: false,
                  allowed: true,
                  gating: true,
                },
              ],
              planType: null,
              checkedAt: "2026-11-01T12:00:00.000Z",
              source: "plugin:cliproxy-connector",
              quotaBlind: false,
              accountHash: "h",
              lastError: null,
              coolingDown: false,
              cooldownUntil: null,
            },
          }) as never,
      },
    };
    const result = await routeWithCache(ctx as never, {
      companyId: COMPANY,
      now: "2026-11-01T12:00:00.000Z",
      pool: { id: "pool-1", mode: "usage_aware" },
      candidates: [
        {
          member: {
            id: "m-a",
            profile: { model: "acct-claude-1/claude-sonnet-5" },
            binding: { connectionId: "conn-a1" },
          },
        },
      ],
    } as never);
    expect(result).toEqual({ kind: "selected", memberId: "m-a", skipped: {} });
  });
});
