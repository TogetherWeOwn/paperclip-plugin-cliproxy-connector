import { describe, expect, it } from "vitest";
import { aggregateProvider } from "./aggregate.js";
import { parseConfig, type ConnectorConfig } from "./config.js";
import { parseHeaderSignals } from "./parsers.js";
import { detectMissingConnections, resolveProviderRow, route, type RouteInput } from "./router.js";
import type { AccountUsageRow, UsageLimitRow } from "./types.js";

const NOW = "2026-11-01T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const iso = (ms: number) => new Date(ms).toISOString();

function testConfig(over: Record<string, unknown> = {}): ConnectorConfig {
  const { config, validation } = parseConfig({
    cliproxyBaseUrl: "http://127.0.0.1:8317",
    managementKeyHeader: "X-Test-Key",
    managementSecretRef: { uid: "secret-1" },
    providers: [{ provider: "claude", connectionId: "conn-claude", completeInventory: true }],
    ...over,
  });
  expect(validation.ok).toBe(true);
  return config;
}

function limit(over: Partial<UsageLimitRow> = {}): UsageLimitRow {
  return {
    id: "claude:5h",
    label: "Claude unified 5h",
    usedPercent: 20,
    remainingPercent: 80,
    resetsAt: null,
    limitReached: false,
    allowed: true,
    gating: true,
    observedAt: NOW,
    models: null,
    ...over,
  };
}

function row(over: Partial<AccountUsageRow> = {}): AccountUsageRow {
  return {
    key: "acct-a",
    provider: "claude",
    channel: "claude",
    status: "active",
    statusMessage: null,
    priority: null,
    limits: [limit()],
    planType: null,
    checkedAt: NOW,
    source: "plugin:cliproxy-connector",
    quotaBlind: false,
    accountHash: "hash-a",
    lastError: null,
    coolingDown: false,
    cooldownUntil: null,
    ...over,
  };
}

function input(over: Partial<RouteInput> = {}): RouteInput {
  return {
    now: NOW,
    poolId: "pool-1",
    poolMode: "usage_aware",
    memberOrder: [],
    lastMemberId: null,
    candidates: [{ memberId: "m-a", model: "model-a", connectionId: "conn-claude" }],
    rows: [row()],
    config: testConfig(),
    ...over,
  };
}

describe("single-member pools", () => {
  it("selects the member when the provider is allowed", () => {
    const r = route(input());
    expect(r.kind).toBe("selected");
    if (r.kind === "selected") expect(r.memberId).toBe("m-a");
  });

  it("selects on unknown (fail open), never headroom", () => {
    const r = route(input({ rows: [] })); // zero enabled accounts → unknown
    expect(r.kind).toBe("selected");
    if (r.kind === "selected") {
      expect(r.memberId).toBe("m-a");
      // The selected member carries no skipped note; its unknown reason is
      // visible in the aggregate (fail-open, never headroom).
      expect(r.skipped["m-a"]).toBeUndefined();
    }
  });

  it("returns exhausted with retryAt when the provider is exhausted", () => {
    const r = route(
      input({
        rows: [row({ coolingDown: true, cooldownUntil: iso(NOW_MS + 3_600_000), limits: [] })],
      }),
    );
    expect(r).toMatchObject({ kind: "exhausted", retryAt: iso(NOW_MS + 3_600_000) });
  });

  it("clamps retryAt to at least now+1s", () => {
    const r = route(
      input({
        rows: [row({ coolingDown: true, cooldownUntil: iso(NOW_MS + 500), limits: [] })],
      }),
    );
    expect(r.kind).toBe("exhausted");
    if (r.kind === "exhausted") expect(r.retryAt).toBe(iso(NOW_MS + 1000));
  });

  it("unmapped connections route unknown (fail open), never blocked", () => {
    const r = route(input({ candidates: [{ memberId: "m-a", model: "", connectionId: "conn-ghost" }] }));
    expect(r.kind).toBe("selected");
    if (r.kind === "selected") expect(r.memberId).toBe("m-a");
  });

  it("members without a binding connection route unknown (fail open)", () => {
    const r = route(input({ candidates: [{ memberId: "m-a", model: "", connectionId: null }] }));
    expect(r.kind).toBe("selected");
  });
});

describe.each([
  { name: "100% pool threshold", config: {}, poolThresholdPercent: 100 },
  { name: "zero default reserve", config: { reservePercent: 0 }, poolThresholdPercent: undefined },
  { name: "zero per-pool override", config: { perPoolReservePercent: { "pool-1": 0 } }, poolThresholdPercent: 90 },
])("use-until-exhausted: $name", (setting) => {
  function zeroInput(rows: AccountUsageRow[]): RouteInput {
    return input({ rows, config: testConfig(setting.config), poolThresholdPercent: setting.poolThresholdPercent });
  }

  it("admits fresh positive headroom below the former reserve, then waits at zero", () => {
    const reset = iso(NOW_MS + 3_600_000);
    for (const remainingPercent of [1, 0.01, 0]) {
      const rows = [row({ limits: [limit({
        remainingPercent, usedPercent: 100 - remainingPercent, resetsAt: reset,
      })] })];
      const args = zeroInput(rows);
      const assessment = aggregateProvider({
        provider: "claude", model: "model-a", rows, completeInventory: true,
        config: args.config, now: NOW, poolId: args.poolId,
        poolThresholdPercent: args.poolThresholdPercent,
      });
      expect(assessment).toMatchObject({
        state: remainingPercent > 0 ? "allowed" : "exhausted",
        headroomAccounts: remainingPercent > 0 ? 1 : 0,
        retryAt: remainingPercent > 0 ? null : reset,
      });
      expect(route(args)).toMatchObject(remainingPercent > 0
        ? { kind: "selected", memberId: "m-a" }
        : { kind: "exhausted", retryAt: reset });
    }
  });

  it.each([{ allowed: false }, { limitReached: true }])("still honors explicit denial %j", (denial) => {
    const reset = iso(NOW_MS + 120_000);
    expect(route(zeroInput([row({ limits: [limit({ remainingPercent: 1, resetsAt: reset, ...denial })] })])))
      .toMatchObject({ kind: "exhausted", retryAt: reset });
  });

  it("keeps parsed retry-after and account cooldown backoff despite positive quota", () => {
    const { limits } = parseHeaderSignals("claude", { "retry-after": "120" }, NOW, []);
    expect(limits).toHaveLength(1);
    expect(route(zeroInput([row({ limits: [limit({ remainingPercent: 1 }), ...limits] })])))
      .toMatchObject({ kind: "exhausted", retryAt: iso(NOW_MS + 120_000) });
    expect(route(zeroInput([row({ coolingDown: true, cooldownUntil: iso(NOW_MS + 180_000) })])))
      .toMatchObject({ kind: "exhausted", retryAt: iso(NOW_MS + 180_000) });
  });

  it("preserves the bounded recheck when exhausted quota has no reset", () => {
    expect(route(zeroInput([row({ limits: [limit({ remainingPercent: 0, resetsAt: null })] })])))
      .toMatchObject({ kind: "exhausted", retryAt: iso(NOW_MS + 60_000) });
  });
});

describe("reserve routing compatibility", () => {
  it.each([undefined, 90, 99])("still withholds quota at the existing reserve for threshold %s", (poolThresholdPercent) => {
    const reserve = poolThresholdPercent === 99 ? 1 : 10;
    const reset = iso(NOW_MS + 3_600_000);
    expect(route(input({
      poolThresholdPercent,
      rows: [row({ limits: [limit({ remainingPercent: reserve, resetsAt: reset })] })],
    }))).toMatchObject({ kind: "exhausted", retryAt: reset });
  });
});

describe("two-member pools", () => {
  const twoMembers = () => [
    { memberId: "m-a", model: "model-a", connectionId: "conn-claude" },
    { memberId: "m-b", model: "model-b", connectionId: "conn-codex" },
  ];
  function twoProviderConfig(): ConnectorConfig {
    return testConfig({
      providers: [
        { provider: "claude", connectionId: "conn-claude", completeInventory: true },
        { provider: "codex", connectionId: "conn-codex", completeInventory: true },
      ],
    });
  }

  it("skips the exhausted provider and selects the allowed one", () => {
    const r = route(
      input({
        config: twoProviderConfig(),
        candidates: twoMembers(),
        rows: [
          row({ key: "acct-a", coolingDown: true, cooldownUntil: iso(NOW_MS + 3_600_000), limits: [] }),
          {
            ...row({ key: "acct-b", provider: "codex", channel: "codex" }),
            limits: [
              limit({ id: "codex:primary", label: "Codex primary", usedPercent: 10, remainingPercent: 90 }),
            ],
          },
        ],
      }),
    );
    expect(r.kind).toBe("selected");
    if (r.kind === "selected") {
      expect(r.memberId).toBe("m-b");
      expect(r.skipped["m-a"]).toMatch(/every enabled claude account is positively out/);
    }
  });

  it("returns the earliest retryAt when every provider is exhausted", () => {
    const r = route(
      input({
        config: twoProviderConfig(),
        candidates: twoMembers(),
        rows: [
          row({ key: "acct-a", coolingDown: true, cooldownUntil: iso(NOW_MS + 3 * 3_600_000), limits: [] }),
          row({
            key: "acct-b",
            provider: "codex",
            channel: "codex",
            coolingDown: true,
            cooldownUntil: iso(NOW_MS + 1 * 3_600_000),
            limits: [],
          }),
        ],
      }),
    );
    expect(r).toMatchObject({ kind: "exhausted", retryAt: iso(NOW_MS + 1 * 3_600_000) });
  });

  it("rotates among eligible members via memberOrder/lastMemberId", () => {
    const cfg = twoProviderConfig();
    const rows = [
      row({ key: "acct-a" }),
      { ...row({ key: "acct-b", provider: "codex", channel: "codex" }), limits: [limit({ id: "codex:primary" })] },
    ];
    const first = route(
      input({ config: cfg, candidates: twoMembers(), rows, memberOrder: ["m-a", "m-b"], lastMemberId: "m-a" }),
    );
    expect(first).toMatchObject({ kind: "selected", memberId: "m-b" });
    const second = route(
      input({ config: cfg, candidates: twoMembers(), rows, memberOrder: ["m-a", "m-b"], lastMemberId: "m-b" }),
    );
    expect(second).toMatchObject({ kind: "selected", memberId: "m-a" });
  });
});

describe("pinned tasks", () => {
  it("a pinned allowed member is selected", () => {
    const r = route(input({ pinnedMemberId: "m-a" }));
    expect(r).toMatchObject({ kind: "selected", memberId: "m-a" });
  });

  it("a pinned exhausted member waits on its own retryAt (same rule)", () => {
    const r = route(
      input({
        pinnedMemberId: "m-a",
        rows: [row({ coolingDown: true, cooldownUntil: iso(NOW_MS + 3_600_000), limits: [] })],
      }),
    );
    expect(r).toMatchObject({ kind: "exhausted", retryAt: iso(NOW_MS + 3_600_000) });
  });

  it("pinning an unoffered member refuses to migrate", () => {
    const r = route(input({ pinnedMemberId: "m-ghost" }));
    expect(r.kind).toBe("unavailable");
    if (r.kind === "unavailable") expect(r.skipped["m-ghost"]).toMatch(/refusing to migrate/);
  });
});

describe("missing-connection drift (TWO-690)", () => {
  function fleetConfig(): ConnectorConfig {
    return testConfig({
      providers: [
        { provider: "claude", connectionId: "conn-claude", completeInventory: true },
        { provider: "codex", connectionId: "conn-codex", completeInventory: true },
        { provider: "zai", connectionId: "conn-zai", completeInventory: true },
      ],
    });
  }

  it("detectMissingConnections is fleet-wide over the union of every pool's bindings", () => {
    const cfg = fleetConfig();
    expect(resolveProviderRow(cfg, "conn-claude")?.provider).toBe("claude");
    expect(resolveProviderRow(cfg, "conn-ghost")).toBeNull();
    // Every row bound by some pool: no drift.
    expect(detectMissingConnections(cfg, ["conn-claude", "conn-codex", "conn-zai"])).toEqual([]);
    // One pool's members alone must NOT be passed: from a single pool's view
    // the sibling rows look missing, but they are bound elsewhere.
    expect(
      detectMissingConnections(cfg, ["conn-claude"]).map((p) => p.connectionId).sort(),
    ).toEqual(["conn-codex", "conn-zai"]);
  });

  it("a fleet of single-member pools gives no drift", () => {
    const cfg = fleetConfig();
    const pools = ["conn-claude", "conn-codex", "conn-zai"];
    for (const [i, connectionId] of pools.entries()) {
      const r = route(
        input({
          config: cfg,
          poolId: `pool-${i}`,
          candidates: [{ memberId: `m-${i}`, model: "", connectionId }],
          rows: [row({ key: `acct-${i}` })],
        }),
      );
      expect(r.kind).toBe("selected");
      if (r.kind === "selected") {
        expect(Object.values(r.skipped).join("\n")).not.toMatch(/missing-connection/);
      }
    }
    // And the fleet union itself is clean.
    expect(detectMissingConnections(cfg, pools)).toEqual([]);
  });

  it("a row with an unpooled connection gives exactly one finding", () => {
    const cfg = fleetConfig();
    const pooled = ["conn-claude", "conn-codex"]; // conn-zai bound by no pool
    const missing = detectMissingConnections(cfg, pooled);
    expect(missing).toEqual([{ provider: "zai", connectionId: "conn-zai", completeInventory: true }]);
  });

  it("route() reports missing-connection only for this pool's own unmapped member, without blocking selection", () => {
    const cfg = fleetConfig();
    const r = route(
      input({
        config: cfg,
        candidates: [{ memberId: "m-a", model: "", connectionId: "conn-ghost" }],
      }),
    );
    expect(r.kind).toBe("selected");
    if (r.kind === "selected") {
      expect(r.memberId).toBe("m-a");
      expect(r.skipped["pool:pool-1"]).toMatch(/missing-connection/);
      expect(r.skipped["pool:pool-1"]).toMatch(/conn-ghost/);
      // Names only this pool's own binding — never the sibling rows.
      expect(r.skipped["pool:pool-1"]).not.toMatch(/conn-codex|conn-zai/);
    }
  });

  it("members without a binding connection raise no missing-connection note", () => {
    const r = route(input({ config: fleetConfig(), candidates: [{ memberId: "m-a", model: "", connectionId: null }] }));
    expect(r.kind).toBe("selected");
    if (r.kind === "selected") {
      expect(Object.values(r.skipped).join("\n")).not.toMatch(/missing-connection/);
    }
  });
});

describe("pool modes and host contract", () => {
  it("non-usage_aware pools are unavailable with a reason per member", () => {
    const r = route(input({ poolMode: "round_robin" }));
    expect(r.kind).toBe("unavailable");
    if (r.kind === "unavailable") expect(r.skipped["m-a"]).toMatch(/only serves usage_aware/);
  });

  it("empty pools are unavailable with a pool note", () => {
    const r = route(input({ candidates: [] }));
    expect(r.kind).toBe("unavailable");
    if (r.kind === "unavailable") expect(r.skipped["pool:pool-1"]).toMatch(/no eligible candidates/);
  });

  it("results carry exactly { kind, memberId | retryAt, skipped } — retryAt is advisory, native execution input is never touched", () => {
    const selected = route(input());
    expect(Object.keys(selected).sort()).toEqual(["kind", "memberId", "skipped"]);
    const exhausted = route(
      input({ rows: [row({ coolingDown: true, cooldownUntil: iso(NOW_MS + 60_000), limits: [] })] }),
    );
    expect(Object.keys(exhausted).sort()).toEqual(["kind", "retryAt", "skipped"]);
    // Host contract, stated honestly: core clamps the wait; the router never
    // sees or forwards native execution input.
    for (const result of [selected, exhausted]) {
      expect(JSON.stringify(result)).not.toContain("nativeExecutionInput");
    }
  });
});
