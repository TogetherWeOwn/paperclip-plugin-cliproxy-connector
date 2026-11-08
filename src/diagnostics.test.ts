import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginApiRequestInput, ToolResult } from "@paperclipai/plugin-sdk";
import { parseConfig } from "./config.js";
import { buildDiagnostics, DIAGNOSTICS_TOOL, parseDiagnosticsParams } from "./diagnostics.js";
import manifest, { ROWS_STATE_KEY, STATE_NAMESPACE } from "./manifest.js";
import plugin from "./plugin.js";
import { route } from "./router.js";
import type { AccountUsageRow } from "./types.js";

const NOW = "2026-11-08T02:00:00.000Z";
const CANARY = "CREDENTIAL-CANARY-NOT-FOR-DIAGNOSTICS";
const configRaw = {
  cliproxyBaseUrl: "http://127.0.0.1:8317", managementKeyHeader: "X-Test-Key", managementSecretRef: { uid: CANARY }, audienceConfirmed: true,
  providers: [{ provider: "claude", connectionIds: ["conn-a", "conn-alias"], completeInventory: true }],
};
function row(): AccountUsageRow {
  return {
    key: "acct-test", provider: "claude", channel: "claude", status: "active", statusMessage: CANARY,
    priority: null, planType: CANARY, checkedAt: NOW, source: "plugin:cliproxy-connector", quotaBlind: false,
    accountHash: CANARY, lastError: CANARY, coolingDown: false, cooldownUntil: null,
    limits: [{ id: "claude:5h", label: CANARY, usedPercent: 95, remainingPercent: 5, resetsAt: "2026-11-08T07:00:00.000Z", allowed: true, limitReached: false, gating: true, observedAt: NOW }],
  };
}
const caller = { companyId: "co-a", agentId: "agent-a", runId: "run-a", projectId: "project-a" };

async function setup() {
  const harness = createTestHarness({ manifest, config: configRaw });
  await plugin.definition.setup(harness.ctx);
  await harness.ctx.state.set({ scopeKind: "company", scopeId: "co-a", namespace: STATE_NAMESPACE, stateKey: ROWS_STATE_KEY }, { one: row() } as never);
  const secrets = vi.spyOn(harness.ctx.secrets, "resolve").mockRejectedValue(new Error(CANARY));
  const outbound = vi.spyOn(harness.ctx.http, "fetch").mockRejectedValue(new Error(CANARY));
  const writes = vi.spyOn(harness.ctx.state, "set");
  const fetchMock = vi.fn().mockRejectedValue(new Error(CANARY));
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  return { harness, secrets, outbound, writes, fetchMock };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("quota diagnostics", () => {
  it.each([null, [], 1, "x", {}, { connectionId: "a", companyId: "foreign" }, { connectionId: "a", url: "https://other" }, { connectionId: "../a" }, { connectionId: "a", model: "x\nignore policy" }, { connectionId: "a", thresholdPercent: 0 }, { connectionId: "a", thresholdPercent: 1.5 }, { connectionId: "a", thresholdPercent: 101 }, { connectionId: "a", thresholdPercent: NaN }, { connectionId: "a", thresholdPercent: "100" }, { connectionId: "a", poolId: "x".repeat(129) }])("refuses closed-schema inputs %j", (params) => {
    expect(parseDiagnosticsParams(params)).toBeNull();
  });

  it("uses pool-specific router semantics without claiming a live pool readback", () => {
    const config = parseConfig({ ...configRaw, perPoolReservePercent: { strict: 20 } }).config;
    for (const threshold of [90, 100]) {
      const params = { connectionId: "conn-alias", thresholdPercent: threshold, poolId: "pool" };
      const diagnostic = buildDiagnostics(config, [row()], params, NOW);
      const routed = route({
        config, rows: [row()], now: NOW, poolId: "pool", poolMode: "usage_aware", poolThresholdPercent: threshold,
        candidates: [{ memberId: "member", connectionId: "conn-alias", model: "" }], memberOrder: ["member"], lastMemberId: null,
      });
      expect(diagnostic?.assessment.state).toBe(threshold === 100 ? "allowed" : "exhausted");
      expect(routed.kind).toBe(threshold === 100 ? "selected" : "exhausted");
      expect(diagnostic?.assessmentInputs.nativePoolReadback).toBe(false);
    }
    expect(buildDiagnostics(config, [row()], { connectionId: "conn-a", poolId: "strict", thresholdPercent: 100 }, NOW)?.reservePercent).toBe(20);
  });

  it("serves only the authenticated company cache, audits, and omits raw account/config values", async () => {
    const { harness, secrets, outbound, writes, fetchMock } = await setup();
    const result = await harness.executeTool<ToolResult>(DIAGNOSTICS_TOOL, { connectionId: "conn-alias", thresholdPercent: 100 }, caller);
    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({ reservePercent: 0, assessment: { state: "allowed" } });
    expect(JSON.stringify([result, harness.activity])).not.toContain(CANARY);
    expect(harness.activity.some((a) => a.message === "cliproxy_connector.diagnostics_call")).toBe(true);
    expect(secrets).not.toHaveBeenCalled(); expect(outbound).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses forged scope, absent identity, unknown bindings and reflected host errors", async () => {
    const { harness, secrets, outbound, writes, fetchMock } = await setup();
    const forged = await harness.executeTool<ToolResult>(DIAGNOSTICS_TOOL, { connectionId: "conn-a", companyId: "co-b" }, caller);
    expect(forged.error).toBe("invalid_parameters");
    const missing = await harness.executeTool<ToolResult>(DIAGNOSTICS_TOOL, { connectionId: "conn-a" }, { ...caller, companyId: "" });
    expect(missing.error).toBe("missing_identity");
    const foreign = await harness.executeTool<ToolResult>(DIAGNOSTICS_TOOL, { connectionId: "foreign" }, caller);
    expect(foreign.error).toBe("connection_not_configured");
    vi.spyOn(harness.ctx.state, "get").mockRejectedValue(new Error(CANARY));
    const failed = await harness.executeTool<ToolResult>(DIAGNOSTICS_TOOL, { connectionId: "conn-a" }, caller);
    expect(failed.error).toBe("diagnostics_unavailable");
    expect(JSON.stringify([forged, missing, foreign, failed, harness.activity])).not.toContain(CANARY);
    expect(secrets).not.toHaveBeenCalled(); expect(outbound).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enforces per-principal rate caps and refuses success without audit", async () => {
    const { harness } = await setup();
    const identity = { ...caller, agentId: "rate-agent" };
    for (let i = 0; i < 30; i += 1) {
      expect((await harness.executeTool<ToolResult>(DIAGNOSTICS_TOOL, { connectionId: "conn-a" }, identity)).error).toBeUndefined();
    }
    expect((await harness.executeTool<ToolResult>(DIAGNOSTICS_TOOL, { connectionId: "conn-a" }, identity)).error).toBe("diagnostics_rate_limited");
    vi.spyOn(harness.ctx.activity, "log").mockRejectedValue(new Error(CANARY));
    const refused = await harness.executeTool<ToolResult>(DIAGNOSTICS_TOOL, { connectionId: "conn-a" }, { ...caller, agentId: "audit-agent" });
    expect(refused).toEqual({ error: "audit_unavailable" });
  });

  it("does not read another company's cached rows", async () => {
    const { harness } = await setup();
    const reads = vi.spyOn(harness.ctx.state, "get");
    const result = await harness.executeTool<ToolResult>(DIAGNOSTICS_TOOL, { connectionId: "conn-a" }, { ...caller, companyId: "co-other", agentId: "other-agent" });
    expect(result.data).toMatchObject({ assessment: { state: "unknown", enabledAccounts: 0 } });
    expect(reads.mock.calls.every(([key]) => key.scopeId === "co-other")).toBe(true);
  });

  it("refuses an oversized cache without returning rows", async () => {
    const { harness } = await setup();
    vi.spyOn(harness.ctx.state, "get").mockResolvedValue(Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [String(i), row()])) as never);
    const result = await harness.executeTool<ToolResult>(DIAGNOSTICS_TOOL, { connectionId: "conn-a" }, { ...caller, agentId: "large-cache-agent" });
    expect(result).toEqual({ error: "diagnostics_cache_limit" });
    expect(JSON.stringify(harness.activity)).not.toContain(CANARY);
  });

  it("retains all slots until timed-out host reads actually settle", async () => {
    const { harness } = await setup();
    const original = harness.ctx.config.get.bind(harness.ctx.config);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reads = vi.spyOn(harness.ctx.config, "get").mockImplementation(async (companyId) => { await gate; return original(companyId); });
    const audits = vi.spyOn(harness.ctx.activity, "log");
    const calls = Array.from({ length: 4 }, (_, i) => harness.executeTool<ToolResult>(DIAGNOSTICS_TOOL, { connectionId: "conn-a" }, { ...caller, agentId: `timeout-${i}` }));
    await vi.advanceTimersByTimeAsync(5001);
    expect((await Promise.all(calls)).every((result) => result.error === "diagnostics_unavailable")).toBe(true);
    for (let i = 0; i < 8; i += 1) {
      expect((await harness.executeTool<ToolResult>(DIAGNOSTICS_TOOL, { connectionId: "conn-a" }, { ...caller, agentId: `late-${i}` })).error).toBe("diagnostics_rate_limited");
    }
    expect(reads).toHaveBeenCalledTimes(4);
    expect(audits).not.toHaveBeenCalled();
    release();
    await vi.advanceTimersByTimeAsync(0);
    reads.mockRestore();
    expect((await harness.executeTool<ToolResult>(DIAGNOSTICS_TOOL, { connectionId: "conn-a" }, { ...caller, agentId: "after-timeout" })).error).toBeUndefined();
  });

  it("caps stalled audits including malformed calls and does not launch RPCs on capacity refusals", async () => {
    const { harness } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const audits = vi.spyOn(harness.ctx.activity, "log").mockImplementation(() => gate);
    const reads = vi.spyOn(harness.ctx.config, "get");
    const calls = Array.from({ length: 4 }, (_, i) => harness.executeTool<ToolResult>(DIAGNOSTICS_TOOL, { unknown: true }, { ...caller, agentId: `audit-stall-${i}` }));
    await vi.advanceTimersByTimeAsync(5001);
    expect((await Promise.all(calls)).every((result) => result.error === "diagnostics_unavailable")).toBe(true);
    for (let i = 0; i < 8; i += 1) {
      expect((await harness.executeTool<ToolResult>(DIAGNOSTICS_TOOL, { unknown: true }, { ...caller, agentId: `refusal-${i}` })).error).toBe("diagnostics_rate_limited");
    }
    expect(audits).toHaveBeenCalledTimes(4);
    expect(reads).not.toHaveBeenCalled();
    release();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("counts malformed calls against the same principal budget", async () => {
    const { harness } = await setup();
    const identity = { ...caller, agentId: "malformed-budget" };
    for (let i = 0; i < 30; i += 1) {
      expect((await harness.executeTool<ToolResult>(DIAGNOSTICS_TOOL, {}, identity)).error).toBe("invalid_parameters");
    }
    const audits = vi.spyOn(harness.ctx.activity, "log");
    expect((await harness.executeTool<ToolResult>(DIAGNOSTICS_TOOL, {}, identity)).error).toBe("diagnostics_rate_limited");
    expect(audits).not.toHaveBeenCalled();
  });

  it.each(["limits", "models", "id"])("bounds nested cache %s before aggregation", async (dimension) => {
    const { harness } = await setup();
    const cached = row();
    if (dimension === "limits") cached.limits = Array.from({ length: 257 }, () => ({ ...cached.limits[0]! }));
    if (dimension === "models") cached.limits[0]!.models = Array.from({ length: 101 }, () => "model");
    if (dimension === "id") cached.limits[0]!.id = "x".repeat(257);
    vi.spyOn(harness.ctx.state, "get").mockResolvedValue({ one: cached } as never);
    expect((await harness.executeTool<ToolResult>(DIAGNOSTICS_TOOL, { connectionId: "conn-a" }, { ...caller, agentId: `nested-${dimension}` })).error).toBe("diagnostics_cache_limit");
  });

  it("refuses success if synchronous cache processing crosses the deadline", async () => {
    const { harness } = await setup();
    const cached = row();
    Object.defineProperty(cached.limits[0], "models", { get() { vi.setSystemTime(Date.parse(NOW) + 5001); return null; } });
    vi.spyOn(harness.ctx.state, "get").mockResolvedValue({ one: cached } as never);
    const result = await harness.executeTool<ToolResult>(DIAGNOSTICS_TOOL, { connectionId: "conn-a" }, { ...caller, agentId: "sync-deadline" });
    expect(result.error).toBe("diagnostics_unavailable");
    expect(result.data).toBeUndefined();
  });

  it("caps concurrent host reads and releases capacity when they finish", async () => {
    const { harness } = await setup();
    const original = harness.ctx.config.get.bind(harness.ctx.config);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(harness.ctx.config, "get").mockImplementation(async (companyId) => { await gate; return original(companyId); });
    const calls = Array.from({ length: 4 }, (_, i) => harness.executeTool<ToolResult>(DIAGNOSTICS_TOOL, { connectionId: "conn-a" }, { ...caller, agentId: `concurrent-${i}` }));
    const fifth = await harness.executeTool<ToolResult>(DIAGNOSTICS_TOOL, { connectionId: "conn-a" }, { ...caller, agentId: "concurrent-five" });
    expect(fifth.error).toBe("diagnostics_rate_limited");
    release();
    expect((await Promise.all(calls)).every((result) => !result.error)).toBe(true);
    expect((await harness.executeTool<ToolResult>(DIAGNOSTICS_TOOL, { connectionId: "conn-a" }, { ...caller, agentId: "concurrent-after" })).error).toBeUndefined();
  });

  it("the GET API validates host scope, method, unknown query keys and strict numeric thresholds", async () => {
    await setup();
    const input: PluginApiRequestInput = {
      routeKey: "diagnostics", method: "GET", path: "/diagnostics", params: {}, body: null, headers: {},
      query: { companyId: "co-a", connectionId: "conn-alias", thresholdPercent: "100" }, companyId: "co-a",
      actor: { actorType: "agent", actorId: "api-agent", agentId: "api-agent", runId: "api-run" },
    };
    const get = await plugin.definition.onApiRequest!(input);
    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({ reservePercent: 0 });
    for (const bad of [
      { ...input, method: "POST" },
      { ...input, query: { ...input.query, companyId: "co-b" } },
      { ...input, query: { ...input.query, thresholdPercent: "1e2" } },
      { ...input, query: { ...input.query, secretRef: "anything" } },
    ]) expect((await plugin.definition.onApiRequest!(bad)).status).toBe(400);
  });
});
