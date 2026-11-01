import { describe, expect, it } from "vitest";
import { aggregateProvider } from "./aggregate.js";
import { parseConfig, type ConnectorConfig } from "./config.js";
import type { AccountUsageRow, UsageLimitRow } from "./types.js";

const NOW = "2026-11-01T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const iso = (ms: number) => new Date(ms).toISOString();

function config(over: Record<string, unknown> = {}): ConnectorConfig {
  const { config: c, validation } = parseConfig({
    cliproxyBaseUrl: "http://127.0.0.1:8317",
    managementKeyHeader: "X-Test-Key",
    managementSecretRef: { uid: "secret-1" },
    providers: [{ provider: "claude", connectionId: "conn-claude", completeInventory: true }],
    ...over,
  });
  expect(validation.ok).toBe(true);
  return c;
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
    key: "acct-aaa",
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
    accountHash: "hash-aaa",
    lastError: null,
    coolingDown: false,
    cooldownUntil: null,
    ...over,
  };
}

function assess(rows: AccountUsageRow[], over: Record<string, unknown> = {}) {
  const c = config();
  return aggregateProvider({
    provider: "claude",
    model: null,
    rows,
    completeInventory: true,
    config: c,
    now: NOW,
    ...over,
  });
}

describe("aggregate truth table", () => {
  it("allowed: fresh headroom on an enabled account", () => {
    const a = assess([row()]);
    expect(a.state).toBe("allowed");
    expect(a.retryAt).toBeNull();
    expect(a.headroomAccounts).toBe(1);
    expect(a.reason).not.toBe("");
  });

  it("unknown: healthy but stale observation is never headroom", () => {
    // Genuinely old passive observation (idle account that served traffic 6h
    // ago); cache row is fresh because sync just fetched it.
    const staleObs = iso(NOW_MS - 6 * 3_600_000);
    const r = row({ limits: [limit({ observedAt: staleObs })] });
    const a = assess([r]);
    expect(a.state).toBe("unknown");
    expect(a.retryAt).toBeNull();
    expect(a.headroomAccounts).toBe(0);
  });

  it("unknown: zero enabled accounts is never headroom (missing cache age)", () => {
    const a = aggregateProvider({
      provider: "claude",
      model: null,
      rows: [],
      completeInventory: true,
      config: config(),
      now: NOW,
    });
    expect(a.state).toBe("unknown");
    expect(a.freshness).toBe("missing");
  });

  it("unknown: disabled accounts are excluded (zero enabled)", () => {
    const a = assess([row({ status: "disabled" })]);
    expect(a.state).toBe("unknown");
    expect(a.enabledAccounts).toBe(0);
  });

  it("unknown: expired cache is never a verdict", () => {
    const old = iso(NOW_MS - 2 * 3_600_000); // beyond default grace (30 min)
    const a = assess([row({ checkedAt: old })]);
    expect(a.state).toBe("unknown");
    expect(a.freshness).toBe("expired");
  });

  it("exhausted: every enabled account cooling with future recovery → earliest retryAt", () => {
    const rows = [
      row({ key: "acct-a", coolingDown: true, cooldownUntil: iso(NOW_MS + 3 * 3_600_000), limits: [] }),
      row({ key: "acct-b", coolingDown: true, cooldownUntil: iso(NOW_MS + 1 * 3_600_000), limits: [] }),
    ];
    const a = assess(rows);
    expect(a.state).toBe("exhausted");
    expect(a.retryAt).toBe(iso(NOW_MS + 1 * 3_600_000));
  });

  it("exhausted: quota-exhausted windows with future resets → earliest reset", () => {
    const rows = [
      row({
        key: "acct-a",
        limits: [limit({ remainingPercent: 0, usedPercent: 100, limitReached: true, resetsAt: iso(NOW_MS + 5 * 3_600_000) })],
      }),
      row({
        key: "acct-b",
        limits: [limit({ id: "claude:7d", allowed: false, resetsAt: iso(NOW_MS + 2 * 3_600_000) })],
      }),
    ];
    const a = assess(rows);
    expect(a.state).toBe("exhausted");
    expect(a.retryAt).toBe(iso(NOW_MS + 2 * 3_600_000));
  });

  it("unknown + waitResumeOff: all out but inventory unconfirmed → never wait", () => {
    const rows = [
      row({ key: "acct-a", coolingDown: true, cooldownUntil: iso(NOW_MS + 3_600_000), limits: [] }),
    ];
    const a = assess(rows, { completeInventory: false });
    expect(a.state).toBe("unknown");
    expect(a.waitResumeOff).toBe(true);
    expect(a.retryAt).toBeNull();
    expect(a.reason).toMatch(/wait\/resume off/);
  });

  it("allowed wins over exhausted peers (one headroom account is enough)", () => {
    const rows = [
      row({ key: "acct-a" }),
      row({ key: "acct-b", coolingDown: true, cooldownUntil: iso(NOW_MS + 3_600_000), limits: [] }),
    ];
    const a = assess(rows);
    expect(a.state).toBe("allowed");
    expect(a.headroomAccounts).toBe(1);
  });

  it("retryAt falls back to recheck when exhaustion has no bound", () => {
    const rows = [row({ key: "acct-a", coolingDown: true, cooldownUntil: null, limits: [] })];
    const a = assess(rows);
    expect(a.state).toBe("exhausted");
    expect(a.retryAt).toBe(iso(NOW_MS + 60_000)); // default recheckSeconds
  });

  it("quota-blind providers stay unknown even when complete (never headroom, never wait)", () => {
    const meta = row({ key: "acct-m", provider: "meta", channel: "meta", limits: [], quotaBlind: true });
    const a = aggregateProvider({
      provider: "meta",
      model: null,
      rows: [meta],
      completeInventory: true,
      config: config(),
      now: NOW,
    });
    expect(a.state).toBe("unknown");
    expect(a.retryAt).toBeNull();
  });
});

describe("per-model aggregation", () => {
  function modelRow(): AccountUsageRow {
    return row({
      limits: [
        limit({ observedAt: NOW }), // account-level: applies to every model
        limit({
          id: "claude:model-x",
          label: "Claude unified model-x",
          usedPercent: 100,
          remainingPercent: 0,
          resetsAt: iso(NOW_MS + 3_600_000),
          limitReached: true,
          allowed: false,
          observedAt: NOW,
          models: ["model-x"],
        }),
      ],
    });
  }

  it("the exhausted model window limits only its own model", () => {
    expect(assess([modelRow()], { model: "model-x" }).state).toBe("exhausted");
  });

  it("other models route on the account-level window", () => {
    const a = assess([modelRow()], { model: "other-model" });
    expect(a.state).toBe("allowed");
    expect(a.model).toBe("other-model");
  });

  it("no model requested: any headroom counts", () => {
    expect(assess([modelRow()]).state).toBe("allowed");
  });
});

describe("namespaced requested models (stock CLIProxy ids)", () => {
  function devinRow(): AccountUsageRow {
    return row({
      provider: "devin",
      channel: "devin",
      limits: [
        limit({ id: "devin:5h", label: "Devin 5h", observedAt: NOW }), // account-level
        limit({
          id: "devin:window",
          label: "Devin window",
          usedPercent: 100,
          remainingPercent: 0,
          resetsAt: iso(NOW_MS + 3_600_000),
          limitReached: true,
          allowed: false,
          observedAt: NOW,
          models: ["claude-opus-5-5"],
        }),
      ],
    });
  }

  function devinAssess(model: string) {
    const c = config();
    return aggregateProvider({
      provider: "devin",
      model,
      rows: [devinRow()],
      completeInventory: true,
      config: c,
      now: NOW,
    });
  }

  it("a namespaced request matches the bare model_quotas key", () => {
    expect(devinAssess("devin/claude-opus-5-5").state).toBe("exhausted");
  });

  it("the bare form matches the same window", () => {
    expect(devinAssess("claude-opus-5-5").state).toBe("exhausted");
  });

  it("other models route on the account-level window", () => {
    expect(devinAssess("devin/other-model").state).toBe("allowed");
    expect(devinAssess("other-model").state).toBe("allowed");
  });

  it("a foreign namespace never matches this provider's per-model window", () => {
    // `other/x` must not match the `["x"]` window: no cross-provider match.
    const r = row({
      limits: [
        limit({ observedAt: NOW }),
        limit({
          id: "claude:x",
          usedPercent: 100,
          remainingPercent: 0,
          resetsAt: iso(NOW_MS + 3_600_000),
          limitReached: true,
          allowed: false,
          observedAt: NOW,
          models: ["x"],
        }),
      ],
    });
    const a = assess([r], { model: "other/x" });
    expect(a.state).toBe("allowed");
  });
});

describe("limiting verdict edges", () => {
  it("fresh limiting with no reset stays out (age-independent)", () => {
    const r = row({ limits: [limit({ remainingPercent: 0, usedPercent: 100, limitReached: true, resetsAt: null })] });
    expect(assess([r]).state).toBe("exhausted");
  });

  it("a limiting verdict whose reset already passed becomes unknown", () => {
    const r = row({
      limits: [
        limit({
          remainingPercent: 0,
          usedPercent: 100,
          limitReached: true,
          resetsAt: iso(NOW_MS - 60_000),
          observedAt: iso(NOW_MS - 60_000),
        }),
      ],
    });
    expect(assess([r]).state).toBe("unknown");
  });

  it("a lifted cooldown with no fresh telemetry is unknown, not a wait", () => {
    const r = row({
      coolingDown: true,
      cooldownUntil: iso(NOW_MS - 1000),
      limits: [],
    });
    expect(assess([r]).state).toBe("unknown");
  });
});
