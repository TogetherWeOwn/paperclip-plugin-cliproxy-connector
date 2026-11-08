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
  cliproxyBaseUrl: "http://127.0.0.1:8317", managementSecretRef: { uid: CANARY }, audienceConfirmed: true,
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
