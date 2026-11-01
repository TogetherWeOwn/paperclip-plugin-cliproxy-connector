import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";
import { route, type RouteInput } from "./router.js";
import type { AccountUsageRow, UsageLimitRow } from "./types.js";

const NOW = "2026-11-01T12:00:00.000Z";

function baseConfig() {
  const { config } = parseConfig({
    cliproxyBaseUrl: "http://127.0.0.1:8317",
    managementKeyHeader: "X-Test-Key",
    managementSecretRef: { uid: "secret-1" },
    prefixMap: {
      "acct-a": "conn-a",
      "acct-b": "conn-b",
      "acct-meta": "conn-meta",
    },
    audienceConfirmed: true,
  });
  return config;
}

function limit(over: Partial<UsageLimitRow> & { id: string }): UsageLimitRow {
  return {
    label: over.id,
    usedPercent: null,
    remainingPercent: null,
    resetsAt: null,
    limitReached: false,
    allowed: true,
    gating: true,
    ...over,
  };
}

function row(over: Partial<AccountUsageRow> & { prefix: string }): AccountUsageRow {
  return {
    connectionId: `conn-${over.prefix.replace("acct-", "")}`,
    provider: "claude",
    poolFamily: "unknown",
    limits: [],
    planType: null,
    checkedAt: NOW,
    source: "plugin:cliproxy-connector",
    quotaBlind: false,
    accountHash: "hash",
    lastError: null,
    coolingDown: false,
    cooldownUntil: null,
    ...over,
  };
}

function input(over: Partial<RouteInput>): RouteInput {
  return {
    now: NOW,
    poolId: "pool-1",
    poolMode: "usage_aware",
    memberOrder: [],
    lastMemberId: null,
    candidates: [],
    rows: new Map(),
    config: baseConfig(),
    ...over,
  };
}

const RESET_1H = "2026-11-01T13:00:00.000Z";
const RESET_3H = "2026-11-01T15:00:00.000Z";

describe("healthy selection and rotation", () => {
  it("selects the above-reserve member and rotates after lastMemberId", () => {
    const rows = new Map([
      ["acct-a", row({ prefix: "acct-a", limits: [limit({ id: "claude:5h", remainingPercent: 80, usedPercent: 20, resetsAt: RESET_3H })] })],
      ["acct-b", row({ prefix: "acct-b", limits: [limit({ id: "claude:5h", remainingPercent: 60, usedPercent: 40, resetsAt: RESET_3H })] })],
    ]);
    const candidates = [
      { memberId: "m-a", model: "acct-a/claude-sonnet-5", connectionId: "conn-a" },
      { memberId: "m-b", model: "acct-b/claude-sonnet-5", connectionId: "conn-b" },
    ];
    const first = route(input({ memberOrder: ["m-a", "m-b"], candidates, rows }));
    expect(first.kind).toBe("selected");
    if (first.kind === "selected") expect(first.memberId).toBe("m-a");

    const second = route(input({ memberOrder: ["m-a", "m-b"], lastMemberId: "m-a", candidates, rows }));
    expect(second.kind).toBe("selected");
    if (second.kind === "selected") expect(second.memberId).toBe("m-b");
  });

  it("prefers rotation over most-headroom", () => {
    const rows = new Map([
      ["acct-a", row({ prefix: "acct-a", limits: [limit({ id: "claude:5h", remainingPercent: 15, usedPercent: 85 })] })],
      ["acct-b", row({ prefix: "acct-b", limits: [limit({ id: "claude:5h", remainingPercent: 95, usedPercent: 5 })] })],
    ]);
    const candidates = [
      { memberId: "m-a", model: "acct-a/x", connectionId: "conn-a" },
      { memberId: "m-b", model: "acct-b/x", connectionId: "conn-b" },
    ];
    const r = route(input({ memberOrder: ["m-a", "m-b"], candidates, rows }));
    expect(r.kind).toBe("selected");
    if (r.kind === "selected") expect(r.memberId).toBe("m-a"); // rotation, not most headroom
  });

  it("treats exactly-at-reserve as limiting (strict >)", () => {
    const rows = new Map([
      ["acct-a", row({ prefix: "acct-a", limits: [limit({ id: "claude:5h", remainingPercent: 10, usedPercent: 90 })] })],
    ]);
    const candidates = [{ memberId: "m-a", model: "acct-a/x", connectionId: "conn-a" }];
    const r = route(input({ candidates, rows }));
    expect(r.kind).toBe("exhausted");
  });

  it("governs by the minimum across gating windows", () => {
    const rows = new Map([
      [
        "acct-a",
        row({
          prefix: "acct-a",
          limits: [
            limit({ id: "claude:5h", remainingPercent: 90, usedPercent: 10 }),
            limit({ id: "claude:7d", remainingPercent: 5, usedPercent: 95, resetsAt: RESET_1H }),
          ],
        }),
      ],
    ]);
    const candidates = [{ memberId: "m-a", model: "acct-a/x", connectionId: "conn-a" }];
    const r = route(input({ candidates, rows }));
    expect(r.kind).toBe("exhausted");
    if (r.kind === "exhausted") expect(r.retryAt).toBe(RESET_1H);
  });
});

describe("exhausted and retryAt", () => {
  it("pooled wait uses the earliest known reset", () => {
    const rows = new Map([
      ["acct-a", row({ prefix: "acct-a", limits: [limit({ id: "w", remainingPercent: 0, usedPercent: 100, resetsAt: RESET_3H })] })],
      ["acct-b", row({ prefix: "acct-b", limits: [limit({ id: "w", remainingPercent: 2, usedPercent: 98, resetsAt: RESET_1H })] })],
    ]);
    const candidates = [
      { memberId: "m-a", model: "acct-a/x", connectionId: "conn-a" },
      { memberId: "m-b", model: "acct-b/x", connectionId: "conn-b" },
    ];
    const r = route(input({ candidates, rows }));
    expect(r.kind).toBe("exhausted");
    if (r.kind === "exhausted") expect(r.retryAt).toBe(RESET_1H);
  });

  it("unknown-only pools recheck in 60 s and never emit empty reasons", () => {
    const rows = new Map([["acct-meta", row({ prefix: "acct-meta", provider: "meta", quotaBlind: true })]]);
    const candidates = [{ memberId: "m-m", model: "acct-meta/meta/muse-spark-1.3", connectionId: "conn-meta" }];
    // Quota-blind but fresh: fail-open eligible.
    const open = route(input({ candidates, rows }));
    expect(open.kind).toBe("selected");

    // Same member, expired telemetry, no known reset: exhausted with 60 s recheck.
    const expired = row({
      prefix: "acct-meta",
      provider: "meta",
      quotaBlind: true,
      checkedAt: "2026-11-01T10:00:00.000Z",
    });
    const r = route(input({ candidates, rows: new Map([["acct-meta", expired]]) }));
    expect(r.kind).toBe("exhausted");
    if (r.kind === "exhausted") {
      expect(r.retryAt).toBe("2026-11-01T12:01:00.000Z");
      expect(Object.values(r.skipped).every((s) => s.length > 0)).toBe(true);
    }
  });
});

describe("stale telemetry (bounded fail-open)", () => {
  // maxAge = 2×5min = 10min; grace = 3×10min = 30min.
  const staleOk = "2026-11-01T11:45:00.000Z"; // 15 min old: stale, within grace
  const tooOld = "2026-11-01T11:20:00.000Z"; // 40 min old: beyond grace

  it("fails open within grace to last-known-above-reserve members", () => {
    const rows = new Map([
      ["acct-a", row({ prefix: "acct-a", checkedAt: staleOk, limits: [limit({ id: "w", remainingPercent: 70, usedPercent: 30 })] })],
    ]);
    const candidates = [{ memberId: "m-a", model: "acct-a/x", connectionId: "conn-a" }];
    const r = route(input({ candidates, rows }));
    expect(r.kind).toBe("selected");
  });

  it("fails closed beyond the grace window even when last-known was healthy", () => {
    const rows = new Map([
      ["acct-a", row({ prefix: "acct-a", checkedAt: tooOld, limits: [limit({ id: "w", remainingPercent: 70, usedPercent: 30, resetsAt: RESET_1H })] })],
    ]);
    const candidates = [{ memberId: "m-a", model: "acct-a/x", connectionId: "conn-a" }];
    const r = route(input({ candidates, rows }));
    expect(r.kind).toBe("exhausted");
  });

  it("excludes stale last-known-below-reserve members", () => {
    const rows = new Map([
      ["acct-a", row({ prefix: "acct-a", checkedAt: staleOk, limits: [limit({ id: "w", remainingPercent: 5, usedPercent: 95, resetsAt: RESET_1H })] })],
      ["acct-b", row({ prefix: "acct-b", limits: [limit({ id: "w", remainingPercent: 80, usedPercent: 20 })] })],
    ]);
    const candidates = [
      { memberId: "m-a", model: "acct-a/x", connectionId: "conn-a" },
      { memberId: "m-b", model: "acct-b/x", connectionId: "conn-b" },
    ];
    const r = route(input({ memberOrder: ["m-a", "m-b"], candidates, rows }));
    expect(r.kind).toBe("selected");
    if (r.kind === "selected") expect(r.memberId).toBe("m-b");
  });
});

describe("pinned tasks", () => {
  const healthyRows = () =>
    new Map([
      ["acct-a", row({ prefix: "acct-a", limits: [limit({ id: "w", remainingPercent: 80, usedPercent: 20 })] })],
      ["acct-b", row({ prefix: "acct-b", limits: [limit({ id: "w", remainingPercent: 80, usedPercent: 20 })] })],
    ]);

  it("selects a healthy pinned member even when dropped from memberOrder", () => {
    const candidates = [
      { memberId: "m-a", model: "acct-a/x", connectionId: "conn-a" },
      { memberId: "m-b", model: "acct-b/x", connectionId: "conn-b" },
    ];
    const r = route(input({ memberOrder: ["m-a"], pinnedMemberId: "m-b", candidates, rows: healthyRows() }));
    expect(r).toEqual({ kind: "selected", memberId: "m-b", skipped: {} });
  });

  it("never migrates a pinned low member; waits on its latest limiting reset", () => {
    const rows = new Map([
      [
        "acct-b",
        row({
          prefix: "acct-b",
          limits: [
            limit({ id: "w:1", remainingPercent: 5, usedPercent: 95, resetsAt: RESET_1H }),
            limit({ id: "w:2", remainingPercent: 3, usedPercent: 97, resetsAt: RESET_3H }),
          ],
        }),
      ],
    ]);
    const candidates = [{ memberId: "m-b", model: "acct-b/x", connectionId: "conn-b" }];
    const r = route(input({ pinnedMemberId: "m-b", candidates, rows }));
    expect(r.kind).toBe("exhausted");
    if (r.kind === "exhausted") expect(r.retryAt).toBe(RESET_3H); // latest, not earliest
  });

  it("is unavailable (not migrated) when the host does not offer the pinned member", () => {
    const r = route(input({ pinnedMemberId: "m-ghost", candidates: [], rows: new Map() }));
    expect(r.kind).toBe("unavailable");
  });
});

describe("admission signals and window classification", () => {
  it("waits on allowed:null for providers with an admission signal", () => {
    const rows = new Map([
      ["acct-a", row({ prefix: "acct-a", limits: [limit({ id: "codex:5h", remainingPercent: 80, usedPercent: 20, allowed: null })] })],
    ]);
    rows.get("acct-a")!.provider = "codex";
    const candidates = [{ memberId: "m-a", model: "acct-a/gpt-6.1-sol", connectionId: "conn-a" }];
    const r = route(input({ candidates, rows }));
    expect(r.kind).toBe("exhausted");
  });

  it("ignores allowed:null for providers without an admission signal", () => {
    const rows = new Map([
      ["acct-meta", row({ prefix: "acct-meta", provider: "meta", limits: [limit({ id: "meta:x", remainingPercent: 80, usedPercent: 20, allowed: null })] })],
    ]);
    const candidates = [{ memberId: "m-m", model: "acct-meta/meta/m", connectionId: "conn-meta" }];
    const r = route(input({ candidates, rows }));
    expect(r.kind).toBe("selected");
  });

  it("ignores feature-scoped windows", () => {
    const rows = new Map([
      [
        "acct-a",
        row({
          prefix: "acct-a",
          limits: [
            limit({ id: "codex:review", remainingPercent: 0, usedPercent: 100, gating: false }),
          ],
        }),
      ],
    ]);
    const candidates = [{ memberId: "m-a", model: "acct-a/x", connectionId: "conn-a" }];
    const r = route(input({ candidates, rows }));
    // No gating windows at all → quota-blind-style unknown → fail-open.
    expect(r.kind).toBe("selected");
  });

  it("spend-control blocks always gate", () => {
    const rows = new Map([
      ["acct-a", row({ prefix: "acct-a", limits: [limit({ id: "w", remainingPercent: 90, usedPercent: 10, allowed: false })] })],
    ]);
    const candidates = [{ memberId: "m-a", model: "acct-a/x", connectionId: "conn-a" }];
    const r = route(input({ candidates, rows }));
    expect(r.kind).toBe("exhausted");
  });

  it("excludes cooling-down members with the cooldown retryAt", () => {
    const rows = new Map([
      ["acct-a", row({ prefix: "acct-a", coolingDown: true, cooldownUntil: RESET_1H, limits: [limit({ id: "w", remainingPercent: 80, usedPercent: 20 })] })],
    ]);
    const candidates = [{ memberId: "m-a", model: "acct-a/x", connectionId: "conn-a" }];
    const r = route(input({ candidates, rows }));
    expect(r.kind).toBe("exhausted");
    if (r.kind === "exhausted") expect(r.retryAt).toBe(RESET_1H);
  });
});

describe("identity and config", () => {
  it("distrusts rows that disagree with the operator map", () => {
    const rows = new Map([
      ["acct-a", row({ prefix: "acct-a", connectionId: "conn-EVIL", limits: [limit({ id: "w", remainingPercent: 80, usedPercent: 20 })] })],
    ]);
    const candidates = [{ memberId: "m-a", model: "acct-a/x", connectionId: "conn-a" }];
    const r = route(input({ candidates, rows }));
    // Untrusted → unknown → fail-open eligible (never silently trusted).
    expect(r.kind).toBe("selected");
    if (r.kind === "selected") {
      expect(r.skipped).toEqual({});
    }
  });

  it("skips unpinned member models with a non-empty reason", () => {
    const candidates = [{ memberId: "m-x", model: "bare-model-id", connectionId: null }];
    const r = route(input({ candidates, rows: new Map() }));
    expect(r.kind).toBe("exhausted");
    if (r.kind === "exhausted") {
      expect(Object.values(r.skipped)[0]).toMatch(/not a pinned/);
    }
  });

  it("returns unavailable with reasons for non-usage_aware pools", () => {
    const candidates = [{ memberId: "m-a", model: "acct-a/x", connectionId: "conn-a" }];
    const r = route(input({ poolMode: "round_robin", candidates, rows: new Map() }));
    expect(r.kind).toBe("unavailable");
    if (r.kind === "unavailable") {
      expect(r.skipped["m-a"]).toMatch(/usage_aware/);
    }
  });

  it("derives the reserve from the pool threshold instead of hard-gating", () => {
    const config = baseConfig();
    const rows = new Map([
      ["acct-a", row({ prefix: "acct-a", limits: [limit({ id: "w", remainingPercent: 15, usedPercent: 85 })] })],
    ]);
    const candidates = [{ memberId: "m-a", model: "acct-a/x", connectionId: "conn-a" }];
    // Pool threshold 90 → 10% reserve → 15% is healthy.
    expect(route(input({ config, candidates, rows, poolThresholdPercent: 90 })).kind).toBe("selected");
    // Pool threshold 80 → 20% reserve → 15% is low.
    expect(route(input({ config, candidates, rows, poolThresholdPercent: 80 })).kind).toBe("exhausted");
  });

  it("clamps retryAt to at least now+1s", () => {
    const rows = new Map([
      ["acct-a", row({ prefix: "acct-a", limits: [limit({ id: "w", remainingPercent: 0, usedPercent: 100, resetsAt: "2026-11-01T11:00:00.000Z" })] })],
    ]);
    const candidates = [{ memberId: "m-a", model: "acct-a/x", connectionId: "conn-a" }];
    const r = route(input({ candidates, rows }));
    expect(r.kind).toBe("exhausted");
    if (r.kind === "exhausted") {
      expect(Date.parse(r.retryAt) - Date.parse(NOW)).toBeGreaterThanOrEqual(1000);
    }
  });
});
