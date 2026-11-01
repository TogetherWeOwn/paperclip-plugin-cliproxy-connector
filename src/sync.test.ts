import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "./config.js";
import {
  emptyStrikeBudget,
  reenableAfterStrike,
  runSync,
  type SyncDeps,
} from "./sync.js";
import type { StrikeBudgetState, SyncFailure, SyncSummary } from "./types.js";

const NOW = "2026-11-01T12:00:00.000Z";
const KEY = "SECRET-KEY-MATERIAL-abc123";

function baseConfigRaw() {
  return {
    cliproxyBaseUrl: "http://127.0.0.1:8317",
    managementKeyHeader: "X-Test-Key",
    managementSecretRef: { uid: "secret-1" },
    prefixMap: { "acct-claude-1": "conn-a1", "acct-meta-1": "conn-m1", "acct-ghost-1": "conn-g1" },
    pluginQuotaIds: { "acct-claude-1": "claude-quota" },
    audienceConfirmed: true,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function authFilesBody() {
  return [
    {
      prefix: "acct-claude-1",
      channel: "claude",
      quota: {
        observed_at: NOW,
        signals: [{ window: "5h", usedPercent: 20, resetAt: "2026-11-01T17:00:00Z" }],
      },
    },
    { prefix: "acct-meta-1", channel: "meta" },
  ];
}

function pluginQuotaBody() {
  return { Groups: [{ Buckets: [{ Window: "5h", RemainingFraction: 0.8 }] }] };
}

/** Fetch mock routing by pathname. `overrides` may force statuses per route. */
function mockFetch(overrides?: { authFilesStatus?: number; pluginStatus?: number }) {
  return vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname === "/v0/management/auth-files") {
      if (overrides?.authFilesStatus) return new Response("nope", { status: overrides.authFilesStatus });
      return jsonResponse(200, authFilesBody());
    }
    if (url.pathname.includes("/plugins/")) {
      if (overrides?.pluginStatus === 401) return new Response("nope", { status: 401 });
      if (overrides?.pluginStatus === 500) return new Response("boom", { status: 500 });
      return jsonResponse(200, pluginQuotaBody());
    }
    return new Response("not found", { status: 404 });
  });
}

interface Store {
  strike: StrikeBudgetState;
  rows: Record<string, never>;
  savedRows: Record<string, never> | null;
  lastSync: SyncSummary | null;
  savedSummary: SyncSummary | null;
  failure: SyncFailure | null;
  activity: Array<{ message: string; metadata?: Record<string, unknown> }>;
}

function store(over?: Partial<Store>): Store {
  return {
    strike: emptyStrikeBudget(),
    rows: {},
    savedRows: null,
    lastSync: null,
    savedSummary: null,
    failure: null,
    activity: [],
    ...over,
  };
}

function deps(s: Store, fetchImpl?: typeof fetch): SyncDeps {
  const { config } = parseConfig(baseConfigRaw());
  return {
    config,
    companyId: "co-1",
    now: NOW,
    resolveSecret: async () => KEY,
    fetchImpl,
    loadStrike: async () => s.strike,
    saveStrike: async (next) => {
      s.strike = next;
    },
    loadRows: async () => ({}) as never,
    loadLastSync: async () => s.lastSync,
    saveSync: async (rows, summary) => {
      s.savedRows = rows as never;
      s.savedSummary = summary;
    },
    recordFailure: async (failure) => {
      s.failure = failure;
    },
    logActivity: async (message, metadata) => {
      s.activity.push({ message, metadata });
    },
  };
}

function assertNoKeyLeak(s: Store) {
  const blob = JSON.stringify([s.activity, s.savedSummary, s.strike, s.failure]);
  expect(blob).not.toContain(KEY);
}

describe("happy path", () => {
  it("writes one row per account, keeps quota-blind accounts unknown, and surfaces drift", async () => {
    const s = store();
    const summary = await runSync(deps(s, mockFetch() as unknown as typeof fetch), { running: false });
    expect(summary.skipped).toBe(false);
    expect(summary.accountsSeen).toBe(2);
    expect(summary.rowsWritten).toBe(2);

    const rows = s.savedRows as unknown as Record<string, { quotaBlind: boolean; connectionId: string | null }>;
    expect(rows["acct-claude-1"].quotaBlind).toBe(false);
    expect(rows["acct-meta-1"].quotaBlind).toBe(true); // unknown, never headroom
    expect(rows["acct-claude-1"].connectionId).toBe("conn-a1");

    const kinds = (summary.drift ?? []).map((d) => d.kind);
    expect(kinds).toContain("mapped-but-missing"); // acct-ghost-1 in map, absent upstream
    assertNoKeyLeak(s);
  });

  it("treats a failing plugin route as best-effort: passive signals survive", async () => {
    const s = store();
    const summary = await runSync(
      deps(s, mockFetch({ pluginStatus: 500 }) as unknown as typeof fetch),
      { running: false },
    );
    expect(summary.skipped).toBe(false);
    expect(summary.errors.some((e) => e.includes("acct-claude-1"))).toBe(true);
    const rows = s.savedRows as unknown as Record<string, { limits: unknown[] }>;
    // Passive auth-files signal still present for acct-claude-1.
    expect(rows["acct-claude-1"].limits.length).toBeGreaterThan(0);
    assertNoKeyLeak(s);
  });

  it("flags duplicates and unkeyed entries as drift", async () => {
    const fetchDup = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/management/auth-files") {
        return jsonResponse(200, [
          { prefix: "acct-claude-1", channel: "claude", quota: { observed_at: NOW, signals: [] } },
          { prefix: "acct-claude-1", channel: "claude", quota: { observed_at: NOW, signals: [] } },
          { channel: "claude" },
        ]);
      }
      return new Response("not found", { status: 404 });
    });
    const s = store();
    const summary = await runSync(deps(s, fetchDup as unknown as typeof fetch), { running: false });
    const kinds = (summary.drift ?? []).map((d) => d.kind);
    expect(kinds).toContain("duplicate-prefix");
    expect(kinds).toContain("unkeyed-observation");
  });
});

describe("strike budget (TWO-378 lesson)", () => {
  it("first 401 stops the run and marks the secret bad without disabling", async () => {
    const s = store();
    const summary = await runSync(
      deps(s, mockFetch({ authFilesStatus: 401 }) as unknown as typeof fetch),
      { running: false },
    );
    expect(summary.skipped).toBe(true);
    expect(s.strike.secretBad).toBe(true);
    expect(s.strike.disabled).toBe(false);
    expect(s.strike.failures).toHaveLength(1);
    expect(s.savedRows).toBeNull(); // nothing persisted on auth failure
    assertNoKeyLeak(s);
  });

  it.each([401, 403])("HTTP %i stops the run and spends one strike", async (status) => {
    const s = store();
    const summary = await runSync(
      deps(s, mockFetch({ authFilesStatus: status }) as unknown as typeof fetch),
      { running: false },
    );
    expect(summary.skipped).toBe(true);
    expect(s.strike.secretBad).toBe(true);
    expect(s.strike.failures).toHaveLength(1);
    expect(s.savedRows).toBeNull();
    assertNoKeyLeak(s);
  });

  it("second 401 in 30 min hard-disables until explicit board re-enable", async () => {
    const s = store({
      strike: {
        // secretBad:false: the board re-enabled after the first rejection,
        // clearing secretBad but keeping the rolling failure.
        failures: [new Date(Date.parse(NOW) - 5 * 60_000).toISOString()],
        disabled: false,
        disabledAt: null,
        disabledReason: null,
        secretBad: false,
      },
    });
    const summary = await runSync(
      deps(s, mockFetch({ authFilesStatus: 401 }) as unknown as typeof fetch),
      { running: false },
    );
    expect(s.strike.disabled).toBe(true);
    expect(s.strike.disabledAt).not.toBeNull();
    expect(summary.skipReason).toMatch(/hard-disabled/);

    // Disabled sync refuses to run — fetch is never called.
    const fetchMock = mockFetch() as unknown as typeof fetch;
    const again = await runSync(deps(s, fetchMock), { running: false });
    expect(again.skipped).toBe(true);
    expect(again.skipReason).toMatch(/hard-disabled/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a config edit never resets the budget — only the board re-enable does", async () => {
    const s = store({
      strike: {
        failures: [NOW],
        disabled: true,
        disabledAt: NOW,
        disabledReason: "spent",
        secretBad: true,
      },
    });
    // "Edited" config: different intervals, different map — budget must persist.
    const edited = parseConfig({
      ...baseConfigRaw(),
      syncIntervalMinutes: 2,
      reservePercent: 20,
      prefixMap: { "acct-claude-1": "conn-a1" },
    }).config;
    const d = deps(s, mockFetch() as unknown as typeof fetch);
    d.config = edited;
    const summary = await runSync(d, { running: false });
    expect(summary.skipped).toBe(true);
    expect(summary.skipReason).toMatch(/Board re-enable required/);

    // The board re-enable keeps the rolling failure (CLIProxy's own 30 min
    // counter does not reset), but clears the hard stop so the next probe
    // is allowed — with one strike left in the window.
    const next = await reenableAfterStrike(
      async () => s.strike,
      async (v) => {
        s.strike = v;
      },
      NOW,
    );
    expect(next.disabled).toBe(false);
    expect(next.failures).toEqual([NOW]);
    expect(next.secretBad).toBe(false);
  });

  it("old failures outside the 30 min window do not count", async () => {
    const s = store({
      strike: {
        failures: [new Date(Date.parse(NOW) - 60 * 60_000).toISOString()],
        disabled: false,
        disabledAt: null,
        disabledReason: null,
        secretBad: false,
      },
    });
    await runSync(deps(s, mockFetch({ authFilesStatus: 401 }) as unknown as typeof fetch), {
      running: false,
    });
    expect(s.strike.disabled).toBe(false);
    expect(s.strike.failures).toHaveLength(1); // old one pruned, new one kept
  });

  it("never re-probes while secretBad is set — only a board re-enable clears it (M2a)", async () => {
    const s = store({
      strike: {
        failures: [new Date(Date.parse(NOW) - 5 * 60_000).toISOString()],
        disabled: false,
        disabledAt: null,
        disabledReason: null,
        secretBad: true,
      },
    });
    const fetchMock = mockFetch({ authFilesStatus: 401 }) as unknown as typeof fetch;
    const summary = await runSync(deps(s, fetchMock), { running: false });
    expect(summary.skipped).toBe(true);
    expect(summary.skipReason).toMatch(/no probe was sent/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(s.strike.failures).toHaveLength(1); // no second strike spent
    expect(s.failure).toBeNull(); // the skip reuses the recorded auth failure
  });

  it("re-enable inside a full window does not allow a 3rd rejection (M2b)", async () => {
    const t0 = new Date(Date.parse(NOW) - 10 * 60_000).toISOString();
    const t1 = new Date(Date.parse(NOW) - 5 * 60_000).toISOString();
    const s = store({
      strike: {
        failures: [t0, t1],
        disabled: true,
        disabledAt: t1,
        disabledReason: "spent",
        secretBad: true,
      },
    });
    // Board re-enables, but the window is still full: the budget stays spent
    // with a wait-until time, and no probe is ever sent.
    const next = await reenableAfterStrike(
      async () => s.strike,
      async (v) => {
        s.strike = v;
      },
      NOW,
    );
    expect(next.disabled).toBe(true);
    expect(next.failures).toEqual([t0, t1]);
    expect(next.disabledReason).toMatch(/wait until/);

    const fetchMock = mockFetch({ authFilesStatus: 401 }) as unknown as typeof fetch;
    const summary = await runSync(deps(s, fetchMock), { running: false });
    expect(summary.skipped).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(s.strike.failures).toHaveLength(2); // still 2 rejections total
  });

  it("a full window refuses to probe even when not disabled (M2b guard)", async () => {
    const t0 = new Date(Date.parse(NOW) - 10 * 60_000).toISOString();
    const t1 = new Date(Date.parse(NOW) - 5 * 60_000).toISOString();
    const s = store({
      strike: { failures: [t0, t1], disabled: false, disabledAt: null, disabledReason: null, secretBad: false },
    });
    const fetchMock = mockFetch({ authFilesStatus: 401 }) as unknown as typeof fetch;
    const summary = await runSync(deps(s, fetchMock), { running: false });
    expect(summary.skipped).toBe(true);
    expect(summary.skipReason).toMatch(/wait until/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(s.strike.disabled).toBe(true);
    expect(s.strike.failures).toHaveLength(2);
  });

  it("companies sharing one origin share one budget: 2 rejections max per 30 min (M1)", async () => {
    // One shared strike store = one instance-scoped bucket for the origin.
    const s = store();
    const badFetch = () => mockFetch({ authFilesStatus: 401 }) as unknown as typeof fetch;

    // Company A syncs at T with a bad key: 1st rejection, secret marked bad.
    const dA = deps(s, badFetch());
    const rA = await runSync(dA, { running: false });
    expect(rA.skipped).toBe(true);
    expect(s.strike.failures).toHaveLength(1);
    expect(s.strike.secretBad).toBe(true);

    // Company B syncs at T+5m against the same origin: skipped WITHOUT a
    // probe — no 2nd rejection while secretBad is set.
    const fetchB = badFetch();
    const dB = deps(s, fetchB);
    dB.now = new Date(Date.parse(NOW) + 5 * 60_000).toISOString();
    const rB = await runSync(dB, { running: false });
    expect(rB.skipped).toBe(true);
    expect(fetchB).not.toHaveBeenCalled();
    expect(s.strike.failures).toHaveLength(1);

    // Board re-enables (keeps [T]); company B probes at T+6m with the still-
    // bad key: 2nd rejection, hard-disable.
    const reenabled = await reenableAfterStrike(
      async () => s.strike,
      async (v) => {
        s.strike = v;
      },
      dB.now,
    );
    expect(reenabled.disabled).toBe(false);
    expect(reenabled.failures).toHaveLength(1);
    const fetchB2 = badFetch();
    const dB2 = deps(s, fetchB2);
    dB2.now = new Date(Date.parse(NOW) + 6 * 60_000).toISOString();
    await runSync(dB2, { running: false });
    expect(s.strike.disabled).toBe(true);
    expect(s.strike.failures).toHaveLength(2);

    // Company A syncs at T+10m: skipped without a probe — the host-wide ban
    // (5 bad keys per 30 min) is never approached.
    const fetchA2 = badFetch();
    const dA2 = deps(s, fetchA2);
    dA2.now = new Date(Date.parse(NOW) + 10 * 60_000).toISOString();
    await runSync(dA2, { running: false });
    expect(fetchA2).not.toHaveBeenCalled();
    expect(s.strike.failures).toHaveLength(2);
  });
});

describe("run guards", () => {
  it("single-flight: a running sync makes the second call skip", async () => {
    const s = store();
    const summary = await runSync(deps(s, mockFetch() as unknown as typeof fetch), { running: true });
    expect(summary.skipped).toBe(true);
    expect(summary.skipReason).toMatch(/single-flight/);
    expect(s.savedRows).toBeNull();
  });

  it("minimum interval: a just-finished sync is not re-run", async () => {
    const s = store({
      lastSync: {
        accountsSeen: 1,
        rowsWritten: 1,
        drift: [],
        errors: [],
        skipped: false,
        skipReason: null,
        startedAt: NOW,
        finishedAt: NOW,
      },
    });
    const fetchMock = mockFetch() as unknown as typeof fetch;
    const summary = await runSync(deps(s, fetch), { running: false });
    expect(summary.skipped).toBe(true);
    expect(summary.skipReason).toMatch(/minimum sync interval/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("unresolvable secret fails closed without probing CLIProxy", async () => {
    const s = store();
    const d = deps(s, mockFetch() as unknown as typeof fetch);
    const fetchMock = d.fetchImpl as unknown as ReturnType<typeof mockFetch>;
    d.resolveSecret = async () => {
      throw new Error("no such grant");
    };
    const summary = await runSync(d, { running: false });
    expect(summary.skipped).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    assertNoKeyLeak(s);
  });

  it("empty resolved secret is recorded + logged like an unresolvable one", async () => {
    const s = store();
    const d = deps(s, mockFetch() as unknown as typeof fetch);
    const fetchMock = d.fetchImpl as unknown as ReturnType<typeof mockFetch>;
    d.resolveSecret = async () => "";
    const summary = await runSync(d, { running: false });
    expect(summary.skipped).toBe(true);
    expect(summary.skipReason).toMatch(/resolved empty/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(s.failure?.message).toMatch(/resolved empty/);
    expect(s.activity.some((a) => a.message.includes("resolved empty"))).toBe(true);
    assertNoKeyLeak(s);
  });

  it("an auth failure on the plugin route also spends the budget, not a silent skip", async () => {
    const s = store();
    const summary = await runSync(
      deps(s, mockFetch({ pluginStatus: 401 }) as unknown as typeof fetch),
      { running: false },
    );
    expect(summary.skipped).toBe(true);
    expect(s.strike.secretBad).toBe(true);
    expect(s.strike.failures).toHaveLength(1);
  });
});

describe("sync failure visibility (S2)", () => {
  it("a non-auth failure is recorded + logged without touching last-sync", async () => {
    const lastSync: SyncSummary = {
      accountsSeen: 1,
      rowsWritten: 1,
      drift: [],
      errors: [],
      skipped: false,
      skipReason: null,
      startedAt: "2026-11-01T11:00:00.000Z",
      finishedAt: "2026-11-01T11:00:30.000Z",
    };
    const s = store({ lastSync });
    // CLIProxy down: auth-files returns 500 (non-auth error). Bypass the
    // min-interval guard by making the last success old enough.
    s.lastSync = { ...lastSync, finishedAt: "2026-11-01T11:30:00.000Z" };
    const d = deps(s, mockFetch({ authFilesStatus: 500 }) as unknown as typeof fetch);
    d.now = "2026-11-01T12:00:00.000Z";
    const summary = await runSync(d, { running: false });
    expect(summary.skipped).toBe(true);
    expect(summary.skipReason).toMatch(/sync failed/);
    // Recorded under its own key…
    expect(s.failure).not.toBeNull();
    expect(s.failure?.attemptedAt).toBe("2026-11-01T12:00:00.000Z");
    expect(s.failure?.message).toMatch(/sync failed/);
    // …logged…
    expect(s.activity.some((a) => a.message.includes("sync failed"))).toBe(true);
    // …and last-sync is untouched (finishedAt still drives min-interval).
    expect(s.savedSummary).toBeNull();
    expect(s.lastSync?.finishedAt).toBe("2026-11-01T11:30:00.000Z");
    assertNoKeyLeak(s);
  });

  it("a success clears the recorded failure", async () => {
    const s = store({ failure: { attemptedAt: NOW, message: "sync failed: boom" } });
    const summary = await runSync(deps(s, mockFetch() as unknown as typeof fetch), { running: false });
    expect(summary.skipped).toBe(false);
    expect(s.failure).toBeNull();
  });

  it("an unresolvable secret is recorded, not just logged", async () => {
    const s = store();
    const d = deps(s, mockFetch() as unknown as typeof fetch);
    d.resolveSecret = async () => {
      throw new Error("no such grant");
    };
    const summary = await runSync(d, { running: false });
    expect(summary.skipped).toBe(true);
    expect(s.failure?.message).toMatch(/could not resolve/);
    assertNoKeyLeak(s);
  });
});
