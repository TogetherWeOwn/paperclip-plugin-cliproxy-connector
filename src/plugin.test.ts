import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest, {
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
import plugin, { normaliseStrikeOrigin, routeWithCache, toRouterCandidates } from "./plugin.js";
import type { AccountUsageRow } from "./types.js";

const COMPANY = "co-1";
const KEY = "HARNESS-KEY-MATERIAL-zzz";

const COMPANY_CONFIG = {
  cliproxyBaseUrl: "http://127.0.0.1:8317",
  managementKeyHeader: "X-Test-Key",
  managementSecretRef: { uid: "secret-1" },
  clientApiKeySecretRef: { uid: "secret-client-1" },
  providers: [{ provider: "claude", connectionId: "conn-a1", completeInventory: true }],
  audienceConfirmed: true,
};

function stateKey(stateKey: string) {
  return { scopeKind: "company" as const, scopeId: COMPANY, namespace: STATE_NAMESPACE, stateKey };
}

function instanceStrikeKey() {
  return { scopeKind: "instance" as const, namespace: STATE_NAMESPACE, stateKey: `${STRIKE_STATE_KEY}:loopback:8317` };
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
    if (url.pathname === "/v8/management/credentials") {
      return jsonResponse(200, [
        {
          id: "harness-claude-1",
          provider: "claude",
          quota: {
            observed_at: "2026-11-01T12:00:00.000Z",
            signals: { "anthropic-ratelimit-unified-5h-utilization": "0.2" },
          },
        },
      ]);
    }
    if (url.pathname === "/v0/management/auth-files") {
      return jsonResponse(200, [
        {
          id: "harness-claude-1",
          provider: "claude",
          quota: {
            observed_at: "2026-11-01T12:00:00.000Z",
            signals: { "anthropic-ratelimit-unified-5h-utilization": "0.2" },
          },
        },
      ]);
    }
    if (url.pathname === "/v1/models") {
      return jsonResponse(200, { data: [{ id: "claude-opus-4-5", owned_by: "anthropic" }] });
    }
    return new Response("not found", { status: 404 });
  });
}

async function setup(config: Record<string, unknown> = COMPANY_CONFIG) {
  const harness = createTestHarness({ manifest, config });
  harness.seed({ companies: [{ id: COMPANY }] as never });
  await plugin.definition.setup(harness.ctx);
  harness.ctx.secrets.resolve = (async () => KEY) as never;
  // TWO-749: the worker syncs through the worker-local loopback transport
  // (Node global fetch, guarded in loopback-fetch.ts), never through
  // `ctx.http.fetch` — so the harness stubs the global instead.
  const fetchMock = mockFetch();
  vi.stubGlobal("fetch", fetchMock);
  return { harness, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sync job", () => {
  it("writes usage rows keyed acct-<hash> and a sync summary to plugin state", async () => {
    const { harness, fetchMock } = await setup();
    await harness.runJob(SYNC_JOB_KEY);
    // The worker reaches the loopback origin through the worker-local
    // transport (TWO-749), never through the host SSRF-guarded client.
    // v8 credentials are preferred; v0 auth-files is the fallback.
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(
      "http://127.0.0.1:8317/v8/management/credentials",
    );
    const rows = harness.getState(stateKey(ROWS_STATE_KEY)) as Record<string, AccountUsageRow>;
    const keys = Object.keys(rows);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^acct-[0-9a-f]{16}$/);
    expect(rows[keys[0] as string]?.provider).toBe("claude");
    expect(rows[keys[0] as string]?.quotaBlind).toBe(false);
    const summary = harness.getState(stateKey(LAST_SYNC_STATE_KEY)) as { skipped: boolean };
    expect(summary.skipped).toBe(false);
  });

  it("a clean sync reports success and clears last-error (delete, never set-null)", async () => {
    const { harness } = await setup();
    // A previous failure is recorded under its own key…
    harness.ctx.state.set(stateKey(LAST_ERROR_STATE_KEY), {
      attemptedAt: "2026-11-01T11:00:00.000Z",
      message: "sync failed: boom",
    } as never);
    await harness.runJob(SYNC_JOB_KEY);
    const summary = harness.getState(stateKey(LAST_SYNC_STATE_KEY)) as { skipped: boolean };
    expect(summary.skipped).toBe(false);
    // …and the clean sync removes the key instead of writing null (the host
    // rejects a null value_json, which used to surface as "sync failed").
    expect(harness.getState(stateKey(LAST_ERROR_STATE_KEY))).toBeUndefined();
  });

  it("skips without probing when the company config is invalid", async () => {
    const { harness, fetchMock } = await setup({ cliproxyBaseUrl: "https://x.example" });
    await harness.runJob(SYNC_JOB_KEY);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("persists the skipped summary so the page surfaces the config error", async () => {
    const { harness } = await setup({ cliproxyBaseUrl: "https://x.example" });
    await harness.runJob(SYNC_JOB_KEY);
    const summary = harness.getState(stateKey(LAST_SYNC_STATE_KEY)) as { skipped: boolean; errors: string[] };
    expect(summary.skipped).toBe(true);
    expect(summary.errors[0]).toMatch(/company config is invalid/);
  });

  it("serves page and widget data from the cache", async () => {
    const { harness } = await setup();
    await harness.runJob(SYNC_JOB_KEY);
    const page = await harness.getData<{ providers: Array<{ provider: string }> }>(PAGE_DATA_KEY, {
      companyId: COMPANY,
    });
    expect(page.providers.map((p) => p.provider)).toEqual(["claude"]);
    const widget = await harness.getData<{ status: string }>(WIDGET_DATA_KEY, { companyId: COMPANY });
    expect(widget.status).toBe("healthy");
  });

  it("resync action re-runs the sync; re-enable action clears strikes", async () => {
    const { harness } = await setup();
    const summary = await harness.performAction<{ skipped: boolean }>(
      RESYNC_ACTION_KEY,
      {},
      { companyId: COMPANY },
    );
    expect(summary.skipped).toBe(false);
    const strike = await harness.performAction<{ disabled: boolean }>(
      REENABLE_ACTION_KEY,
      {},
      { companyId: COMPANY, actor: { type: "user", userId: "u-1" } },
    );
    expect(strike.disabled).toBe(false);
  });

  it("re-enable action logs the stable strike_budget_reenabled key with the sentence in metadata", async () => {
    const { harness } = await setup();
    const spy = vi.spyOn(harness.ctx.activity, "log");
    await harness.performAction(
      REENABLE_ACTION_KEY,
      {},
      { companyId: COMPANY, actor: { type: "user", userId: "u-1" } },
    );
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0]?.[0] as { message: string; metadata?: Record<string, unknown> };
    expect(call.message).toBe("cliproxy_connector.strike_budget_reenabled");
    expect(call.message).toMatch(/^cliproxy_connector\.[a-z_]+$/);
    expect(typeof call.metadata?.summary).toBe("string");
    expect(call.metadata?.summary).toContain("u-1");
  });

  it("re-enable action rejects non-board actors (M3)", async () => {
    const { harness } = await setup();
    for (const actor of [
      { type: "agent", agentId: "a-1" },
      { type: "system" },
      undefined, // harness default: system
    ] as const) {
      await expect(
        harness.performAction(REENABLE_ACTION_KEY, {}, { companyId: COMPANY, actor: actor as never }),
      ).rejects.toThrow(/board-user/);
    }
    // No strike state was written for the rejected calls.
    expect(harness.getState(instanceStrikeKey())).toBeUndefined();
  });

  it("a 401 during the job writes the budget to the instance-scoped loopback bucket (M1)", async () => {
    const { harness } = await setup();
    vi.stubGlobal("fetch", (async () => new Response("nope", { status: 401 })) as never);
    await harness.runJob(SYNC_JOB_KEY);
    const strike = harness.getState(instanceStrikeKey()) as { failures: string[]; secretBad: boolean } | null;
    expect(strike).not.toBeNull();
    expect(strike?.failures).toHaveLength(1);
    expect(strike?.secretBad).toBe(true);
  });

  it("resolves the documented secret_ref shape with secretId (TWO-749 Devin round 2)", async () => {
    const { harness } = await setup({
      ...COMPANY_CONFIG,
      managementSecretRef: { type: "secret_ref", secretId: "secret-1", version: "latest" },
      clientApiKeySecretRef: { type: "secret_ref", secretId: "secret-client-1", version: "latest" },
    });
    const seenRefs: unknown[] = [];
    const inner = harness.ctx.secrets.resolve as (ref: unknown, opts?: unknown) => Promise<string>;
    harness.ctx.secrets.resolve = (async (ref: unknown, opts?: unknown) => {
      seenRefs.push(ref);
      return inner(ref, opts);
    }) as never;
    await harness.runJob(SYNC_JOB_KEY);
    // Both refs travel to the host resolver in the documented shape …
    expect(seenRefs).toContainEqual({ type: "secret_ref", secretId: "secret-1", version: "latest" });
    expect(seenRefs).toContainEqual({
      type: "secret_ref",
      secretId: "secret-client-1",
      version: "latest",
    });
    // … and the sync completes against the stubbed loopback transport.
    const summary = harness.getState(stateKey(LAST_SYNC_STATE_KEY)) as { skipped: boolean };
    expect(summary.skipped).toBe(false);
  });
});

describe("config validation and health", () => {
  it("accepts the connector config and rejects insecure ones", async () => {
    const { harness } = await setup();
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
    const { harness } = await setup();
    // Legacy company-scoped key: the route adopts it into the instance-scoped
    // loopback bucket once, then deletes the legacy key.
    const strikeKey = { ...stateKey(STRIKE_STATE_KEY), namespace: "cliproxy-connector" };
    harness.ctx.state.set(strikeKey as never, {
      failures: ["2026-01-01T00:00:00.000Z"],
      disabled: true,
      disabledAt: "2026-01-01T00:00:00.000Z",
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
    // Adopted into the instance-scoped loopback bucket; the legacy key is gone.
    const adopted = harness.getState(instanceStrikeKey()) as { disabled: boolean } | null;
    expect(adopted?.disabled).toBe(false);
    expect(harness.getState(strikeKey)).toBeUndefined();

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

describe("strike keying on loopback:<port> (Security Engineer nit)", () => {
  it("every loopback spelling of one CLIProxy shares one bucket", () => {
    expect(normaliseStrikeOrigin("http://127.0.0.1:8317")).toBe("loopback:8317");
    expect(normaliseStrikeOrigin("http://127.0.0.1:8317/")).toBe("loopback:8317");
    expect(normaliseStrikeOrigin("http://localhost:8317/api")).toBe("loopback:8317");
    expect(normaliseStrikeOrigin("http://[::1]:8317")).toBe("loopback:8317");
    expect(normaliseStrikeOrigin("http://127.0.0.1:9999")).toBe("loopback:9999");
  });

  it("adopts the pre-port-migration origin-format key without resetting the budget", async () => {
    const { harness, fetchMock } = await setup();
    // Legacy origin-format bucket from before the port-keying migration.
    const legacyKey = {
      scopeKind: "instance" as const,
      namespace: STATE_NAMESPACE,
      stateKey: `${STRIKE_STATE_KEY}:http://127.0.0.1:8317`,
    };
    harness.ctx.state.set(legacyKey as never, {
      failures: ["2026-11-01T11:55:00.000Z"],
      disabled: true,
      disabledAt: "2026-11-01T11:55:00.000Z",
      disabledReason: "spent",
      secretBad: true,
    } as never);
    await harness.runJob(SYNC_JOB_KEY);
    // Spent budget carried forward — the sync still refuses to probe.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.getState(legacyKey)).toBeUndefined();
    const adopted = harness.getState(instanceStrikeKey()) as { disabled: boolean } | null;
    expect(adopted?.disabled).toBe(true);
  });
});

describe("router glue", () => {
  it("maps host pool candidates to provider candidates with the requested model", () => {
    const { candidates, poolId, poolMode, poolThresholdPercent } = toRouterCandidates({
      companyId: COMPANY,
      pool: { id: "pool-1", mode: "usage_aware", thresholdPercent: 90 },
      candidates: [
        {
          member: {
            id: "m-a",
            profile: { model: "profile-model" },
            binding: { connectionId: "conn-a1" },
          },
          runtimeConfig: { model: "requested-model" },
        },
      ],
    } as never);
    expect(poolId).toBe("pool-1");
    expect(poolMode).toBe("usage_aware");
    expect(poolThresholdPercent).toBe(90);
    // runtimeConfig.model wins over the member profile model.
    expect(candidates).toEqual([{ memberId: "m-a", model: "requested-model", connectionId: "conn-a1" }]);
  });

  it("falls back to the member profile model when the task names none", () => {
    const { candidates } = toRouterCandidates({
      companyId: COMPANY,
      pool: { id: "pool-1", mode: "usage_aware" },
      candidates: [
        { member: { id: "m-a", profile: { model: "profile-model" }, binding: { connectionId: "conn-a1" } } },
      ],
    } as never);
    expect(candidates).toEqual([{ memberId: "m-a", model: "profile-model", connectionId: "conn-a1" }]);
  });

  it("routeWithCache selects a member with provider headroom from cached rows", async () => {
    const ctx = {
      config: { get: async () => COMPANY_CONFIG },
      state: {
        get: async () =>
          ({
            "acct-aaa": {
              key: "acct-aaa",
              provider: "claude",
              channel: "claude",
              status: "active",
              statusMessage: null,
              priority: null,
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
                  observedAt: "2026-11-01T12:00:00.000Z",
                  models: null,
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
            profile: { model: "model-a" },
            binding: { connectionId: "conn-a1" },
          },
        },
      ],
    } as never);
    expect(result).toEqual({ kind: "selected", memberId: "m-a", skipped: {} });
  });
});
