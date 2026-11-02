import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "./config.js";
import {
  ACTIVITY_DRIFT_CLEARED,
  ACTIVITY_DRIFT_DETECTED,
  ACTIVITY_DRIFT_STILL_PRESENT,
  ACTIVITY_SETUP_ERROR,
  ACTIVITY_SYNC_FAILED,
  ACTIVITY_SYNC_RECOVERED,
  apiCallOriginKey,
  emptyStrikeBudget,
  reenableAfterStrike,
  runSync,
  type SyncDeps,
} from "./sync.js";
import type {
  AccountUsageRow,
  DriftLedger,
  StrikeBudgetState,
  SyncFailure,
  SyncSummary,
} from "./types.js";

const NOW = "2026-11-01T12:00:00.000Z";
const KEY = "SECRET-KEY-MATERIAL-abc123";

function baseConfigRaw() {
  return {
    cliproxyBaseUrl: "http://127.0.0.1:8317",
    managementKeyHeader: "X-Test-Key",
    managementSecretRef: { uid: "secret-1" },
    clientApiKeySecretRef: { uid: "secret-client-1" },
    providers: [
      { provider: "claude", connectionId: "conn-claude", completeInventory: true },
      { provider: "meta", connectionId: "conn-meta", completeInventory: false },
    ],
    pluginQuotaIds: { claude: "claude-quota" },
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
      id: "claude-acct-1",
      provider: "claude",
      quota: {
        observed_at: NOW,
        signals: {
          "anthropic-ratelimit-unified-5h-utilization": "0.2",
          "anthropic-ratelimit-unified-5h-status": "allowed",
        },
      },
    },
    { id: "meta-acct-1", provider: "meta" },
    { id: "ghost-acct-1", provider: "kimi" },
  ];
}

function pluginQuotaBody() {
  return { groups: [{ buckets: [{ window: "weekly", remainingFraction: 0.8 }] }] };
}

function modelsBody() {
  return {
    data: [
      { id: "claude-opus-4-5", owned_by: "anthropic" },
      { id: "devin/claude-opus-4-5", owned_by: "anthropic" },
    ],
  };
}

/** Fetch mock routing by pathname. `overrides` may force statuses per route. */
function mockFetch(overrides?: { authFilesStatus?: number; pluginStatus?: number; modelsStatus?: number }) {
  return vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname === "/v0/management/auth-files") {
      if (overrides?.authFilesStatus) return new Response("nope", { status: overrides.authFilesStatus });
      return jsonResponse(200, authFilesBody());
    }
    if (url.pathname === "/v1/models") {
      if (overrides?.modelsStatus) return new Response("nope", { status: overrides.modelsStatus });
      return jsonResponse(200, modelsBody());
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
  savedRows: Record<string, AccountUsageRow> | null;
  lastSync: SyncSummary | null;
  savedSummary: SyncSummary | null;
  failure: SyncFailure | null;
  /** Null = no ledger ever persisted (pre-upgrade); {} = seeded/cleared. */
  ledger: DriftLedger | null;
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
    ledger: null,
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
    resolveClientSecret: async () => `${KEY}-client`,
    fetchImpl,
    loadStrike: async () => s.strike,
    saveStrike: async (next) => {
      s.strike = next;
    },
    loadRows: async () => ({}) as never,
    loadLastSync: async () => s.lastSync,
    saveSync: async (rows, summary) => {
      s.savedRows = rows;
      s.savedSummary = summary;
    },
    recordFailure: async (failure) => {
      s.failure = failure;
    },
    loadFailure: async () => s.failure,
    loadDriftLedger: async () => s.ledger,
    saveDriftLedger: async (ledger) => {
      s.ledger = ledger;
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
  it("writes one row per account keyed acct-<hash>, keeps blind providers unknown, and surfaces drift", async () => {
    const s = store();
    const summary = await runSync(deps(s, mockFetch() as unknown as typeof fetch), { running: false });
    expect(summary.skipped).toBe(false);
    expect(summary.accountsSeen).toBe(3);
    expect(summary.rowsWritten).toBe(3);

    const rows = s.savedRows as Record<string, AccountUsageRow>;
    const keys = Object.keys(rows);
    expect(keys.every((k) => /^acct-[0-9a-f]{16}$/.test(k))).toBe(true);
    const byProvider = Object.fromEntries(Object.values(rows).map((r) => [r.provider, r]));
    expect(byProvider.claude.quotaBlind).toBe(false);
    expect(byProvider.claude.status).toBe("active");
    expect(byProvider.meta.quotaBlind).toBe(true); // unknown, never headroom
    expect(byProvider.claude.accountHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain("claude-acct-1"); // no raw identifiers

    const drift = summary.drift ?? [];
    expect(drift.map((d) => d.kind)).toContain("unconfigured-provider"); // kimi has no row
    expect(drift.find((d) => d.kind === "unconfigured-provider")?.provider).toBe("kimi");
    assertNoKeyLeak(s);
  });

  it("flags configured providers with zero enabled accounts", async () => {
    const fetchClaudeOnly = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/management/auth-files") {
        return jsonResponse(200, [{ id: "claude-acct-1", provider: "claude" }]);
      }
      if (url.pathname.includes("/plugins/")) return jsonResponse(200, pluginQuotaBody());
      return new Response("not found", { status: 404 });
    });
    const s = store();
    const summary = await runSync(deps(s, fetchClaudeOnly as unknown as typeof fetch), { running: false });
    expect(summary.drift.find((d) => d.kind === "no-enabled-accounts")?.provider).toBe("meta");
  });

  it("never leaks email-style auth-file names into page warnings", async () => {
    const emailName = "user@example.com.json";
    const fetchEmail = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/management/auth-files") {
        return jsonResponse(200, [{ id: "claude-1", name: emailName, provider: "claude" }]);
      }
      if (url.pathname === "/v0/management/auth-files/models") {
        return new Response("boom", { status: 500 });
      }
      if (url.pathname.includes("/plugins/")) return jsonResponse(200, pluginQuotaBody());
      return new Response("not found", { status: 404 });
    });
    const s = store();
    const summary = await runSync(deps(s, fetchEmail as unknown as typeof fetch), { running: false });
    expect(summary.skipped).toBe(false);
    const blob = JSON.stringify([summary.errors, summary.drift, s.activity]);
    expect(blob).not.toContain("user@example.com");
    expect(blob).not.toContain(emailName);
    expect(summary.errors.some((e) => e.includes("auth file"))).toBe(true);
    assertNoKeyLeak(s);
  });

  it("scrubs the auth-file name when a redirect target echoes it back", async () => {
    // A redirect target is server-chosen: its pathname can echo an
    // email-style auth-file name, and the client's redirect refusal embeds
    // that pathname in its error. The persisted warning must carry only the
    // hashed file reference, never the name itself.
    const emailName = "user@example.com.json";
    const fetchRedirectEcho = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/management/auth-files") {
        return jsonResponse(200, [{ id: "claude-1", name: emailName, provider: "claude" }]);
      }
      if (url.pathname === "/v0/management/auth-files/models") {
        return new Response(null, {
          status: 302,
          headers: { location: `/v0/management/auth-files/models/${emailName}` },
        });
      }
      if (url.pathname.includes("/plugins/")) return jsonResponse(200, pluginQuotaBody());
      return new Response("not found", { status: 404 });
    });
    const s = store();
    const summary = await runSync(deps(s, fetchRedirectEcho as unknown as typeof fetch), {
      running: false,
    });
    expect(summary.skipped).toBe(false);
    const blob = JSON.stringify([summary.errors, summary.drift, s.activity]);
    expect(blob).not.toContain("user@example.com");
    expect(blob).not.toContain(emailName);
    expect(summary.errors.some((e) => e.includes("auth file"))).toBe(true);
    assertNoKeyLeak(s);
  });

  it("refused auth-file names become quiet drift, never sync errors, with the raw name scrubbed", async () => {
    // A name that fails client validation (path-like leftover state from a
    // retired plugin) throws CliproxyConfigError with the raw name embedded.
    // The refusal is correct and stays — it is reported as drift, not as a
    // per-run sync error — and the persisted finding must carry only the
    // hashed file reference, never the name itself.
    const evilName = "auths/subscription-pool/manifest.json";
    const fetchInvalid = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/management/auth-files") {
        return jsonResponse(200, [{ id: "stale-1", name: evilName }]);
      }
      if (url.pathname.includes("/plugins/")) return jsonResponse(200, pluginQuotaBody());
      return new Response("not found", { status: 404 });
    });
    const s = store();
    const summary = await runSync(deps(s, fetchInvalid as unknown as typeof fetch), { running: false });
    expect(summary.skipped).toBe(false);
    const blob = JSON.stringify([summary.errors, summary.drift, s.activity]);
    expect(blob).not.toContain(evilName);
    expect(summary.errors.some((e) => e.includes("auth file"))).toBe(false);
    const refused = (summary.drift ?? []).filter((d) => d.kind === "untrusted-auth-file");
    expect(refused).toHaveLength(1);
    expect(refused[0]?.provider).toBe("unknown");
    expect(s.strike.failures).toHaveLength(0);
    assertNoKeyLeak(s);
  });

  it("attaches the per-provider plugin quota to every enabled account of that provider", async () => {
    const s = store();
    await runSync(deps(s, mockFetch() as unknown as typeof fetch), { running: false });
    const rows = s.savedRows as Record<string, AccountUsageRow>;
    const claudeRows = Object.values(rows).filter((r) => r.provider === "claude");
    expect(claudeRows.length).toBeGreaterThan(0);
    for (const r of claudeRows) {
      expect(r.limits.some((l) => l.id === "claude:weekly")).toBe(true);
    }
  });

  it("fetches plugin quota per auth file with auth_index and attaches each payload to its own account", async () => {
    const quotaUrls: string[] = [];
    const fetchPerFile = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/management/auth-files") {
        return jsonResponse(200, [
          { id: "claude-1", provider: "claude", auth_index: "aaaabbbbccccdddd" },
          { id: "claude-2", provider: "claude", auth_index: "1111222233334444" },
        ]);
      }
      if (url.pathname === "/v0/management/plugins/claude-quota/quota") {
        quotaUrls.push(url.toString());
        const idx = url.searchParams.get("auth_index");
        if (idx === "aaaabbbbccccdddd") {
          return jsonResponse(200, { groups: [{ buckets: [{ window: "weekly", remainingFraction: 0.8 }] }] });
        }
        if (idx === "1111222233334444") {
          return jsonResponse(200, { groups: [{ buckets: [{ window: "weekly", remainingFraction: 0.1 }] }] });
        }
        return new Response("auth_index is required", { status: 400 });
      }
      if (url.pathname === "/v1/models") return jsonResponse(200, modelsBody());
      return new Response("not found", { status: 404 });
    });
    const s = store();
    const summary = await runSync(deps(s, fetchPerFile as unknown as typeof fetch), { running: false });
    expect(summary.skipped).toBe(false);
    // One fetch per distinct credential index, each carrying auth_index.
    expect(quotaUrls).toHaveLength(2);
    expect(quotaUrls.every((u) => new URL(u).searchParams.get("auth_index"))).toBe(true);
    expect(summary.errors.some((e) => e.includes("plugin"))).toBe(false);
    const rows = s.savedRows as Record<string, AccountUsageRow>;
    expect(Object.keys(rows)).toHaveLength(2);
    const remaining = Object.values(rows)
      .map((r) => r.limits.find((l) => l.id === "claude:weekly")?.remainingPercent)
      .sort();
    expect(remaining).toEqual([10, 80]);
    expect(s.strike.failures).toHaveLength(0);
    assertNoKeyLeak(s);
  });

  it("sends the per-file quota fetch for a numeric auth_index (upstream shape-tolerance)", async () => {
    const quotaUrls: string[] = [];
    const fetchNumeric = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/management/auth-files") {
        // Numeric shape (a JSON number, not a string) must still drive the
        // per-file fetch — never fall back to the legacy route that 400s on
        // current builds.
        return jsonResponse(200, [{ id: "claude-1", provider: "claude", auth_index: 7 }]);
      }
      if (url.pathname === "/v0/management/plugins/claude-quota/quota") {
        quotaUrls.push(url.toString());
        if (url.searchParams.get("auth_index") === "7") {
          return jsonResponse(200, { groups: [{ buckets: [{ window: "weekly", remainingFraction: 0.6 }] }] });
        }
        return new Response("auth_index is required", { status: 400 });
      }
      if (url.pathname === "/v1/models") return jsonResponse(200, modelsBody());
      return new Response("not found", { status: 404 });
    });
    const s = store();
    const summary = await runSync(deps(s, fetchNumeric as unknown as typeof fetch), { running: false });
    expect(summary.skipped).toBe(false);
    expect(quotaUrls).toHaveLength(1);
    expect(new URL(quotaUrls[0] as string).searchParams.get("auth_index")).toBe("7");
    expect(summary.errors.some((e) => e.includes("plugin"))).toBe(false);
    const rows = s.savedRows as Record<string, AccountUsageRow>;
    expect(Object.keys(rows)).toHaveLength(1);
    expect(Object.values(rows)[0]?.limits.find((l) => l.id === "claude:weekly")).toMatchObject({
      remainingPercent: 60,
    });
    expect(s.strike.failures).toHaveLength(0);
    assertNoKeyLeak(s);
  });

  it("a failing per-file quota fetch is best-effort: the sync succeeds and spends no strike", async () => {
    const fetchOneBad = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/management/auth-files") {
        return jsonResponse(200, [
          { id: "claude-1", provider: "claude", auth_index: "aaaabbbbccccdddd" },
          { id: "claude-2", provider: "claude", auth_index: "deadbeefdeadbeef" },
        ]);
      }
      if (url.pathname === "/v0/management/plugins/claude-quota/quota") {
        if (url.searchParams.get("auth_index") === "aaaabbbbccccdddd") {
          return jsonResponse(200, { groups: [{ buckets: [{ window: "weekly", remainingFraction: 0.8 }] }] });
        }
        return new Response("auth_index is required", { status: 400 });
      }
      if (url.pathname === "/v1/models") return jsonResponse(200, modelsBody());
      return new Response("not found", { status: 404 });
    });
    const s = store();
    const summary = await runSync(deps(s, fetchOneBad as unknown as typeof fetch), { running: false });
    expect(summary.skipped).toBe(false);
    // The 400 warns per file (never the raw index) and spends no strike…
    expect(summary.errors.some((e) => e.includes("claude (plugin claude-quota,"))).toBe(true);
    const blob = JSON.stringify([summary.errors, summary.drift, s.activity]);
    expect(blob).not.toContain("deadbeefdeadbeef");
    expect(s.strike.failures).toHaveLength(0);
    expect(s.strike.secretBad).toBe(false);
    // …while the healthy file's payload still attaches to its own account.
    const rows = s.savedRows as Record<string, AccountUsageRow>;
    const withWeekly = Object.values(rows).filter((r) =>
      r.limits.some((l) => l.id === "claude:weekly"),
    );
    expect(withWeekly).toHaveLength(1);
    assertNoKeyLeak(s);
  });

  it("falls back to one provider-level quota fetch when entries carry no auth_index", async () => {
    const quotaUrls: string[] = [];
    const fetchLegacy = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/management/auth-files") {
        return jsonResponse(200, [
          { id: "claude-1", provider: "claude" },
          { id: "claude-2", provider: "claude" },
        ]);
      }
      if (url.pathname === "/v0/management/plugins/claude-quota/quota") {
        quotaUrls.push(url.toString());
        return jsonResponse(200, pluginQuotaBody());
      }
      if (url.pathname === "/v1/models") return jsonResponse(200, modelsBody());
      return new Response("not found", { status: 404 });
    });
    const s = store();
    const summary = await runSync(deps(s, fetchLegacy as unknown as typeof fetch), { running: false });
    expect(summary.skipped).toBe(false);
    expect(quotaUrls).toHaveLength(1);
    expect(new URL(quotaUrls[0] as string).search).toBe("");
    const rows = s.savedRows as Record<string, AccountUsageRow>;
    for (const r of Object.values(rows)) {
      expect(r.limits.some((l) => l.id === "claude:weekly")).toBe(true);
    }
    assertNoKeyLeak(s);
  });

  it("discovers the plugin quota id from quota_plugin_id when config has none", async () => {
    const quotaUrls: string[] = [];
    const fetchHinted = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/management/auth-files") {
        return jsonResponse(200, [{ id: "claude-1", provider: "claude", quota_plugin_id: "claude-quota" }]);
      }
      if (url.pathname === "/v0/management/plugins/claude-quota/quota") {
        quotaUrls.push(url.toString());
        return jsonResponse(200, pluginQuotaBody());
      }
      if (url.pathname === "/v1/models") return jsonResponse(200, modelsBody());
      return new Response("not found", { status: 404 });
    });
    const s = store();
    const d = deps(s, fetchHinted as unknown as typeof fetch);
    // No hand-maintained pluginQuotaIds: discovery drives the fetch.
    d.config = parseConfig({ ...baseConfigRaw(), pluginQuotaIds: {} }).config;
    const summary = await runSync(d, { running: false });
    expect(summary.skipped).toBe(false);
    expect(quotaUrls).toHaveLength(1);
    const rows = s.savedRows as Record<string, AccountUsageRow>;
    for (const r of Object.values(rows).filter((r) => r.provider === "claude")) {
      expect(r.limits.some((l) => l.id === "claude:weekly")).toBe(true);
    }
    expect(summary.errors.some((e) => e.includes("plugin"))).toBe(false);
    assertNoKeyLeak(s);
  });

  it("fetches each credential against its own advertised plugin when a provider mixes routes", async () => {
    const quotaUrls: string[] = [];
    const fetchMixed = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/management/auth-files") {
        return jsonResponse(200, [
          { id: "claude-1", provider: "claude", auth_index: "aaaabbbbccccdddd", quota_plugin_id: "quota-a" },
          { id: "claude-2", provider: "claude", auth_index: "1111222233334444", quota_plugin_id: "quota-b" },
        ]);
      }
      if (url.pathname === "/v0/management/plugins/quota-a/quota") {
        quotaUrls.push(url.toString());
        return jsonResponse(200, { groups: [{ buckets: [{ window: "weekly", remainingFraction: 0.8 }] }] });
      }
      if (url.pathname === "/v0/management/plugins/quota-b/quota") {
        quotaUrls.push(url.toString());
        return jsonResponse(200, { groups: [{ buckets: [{ window: "5h", remainingFraction: 0.1 }] }] });
      }
      if (url.pathname === "/v1/models") return jsonResponse(200, modelsBody());
      return new Response("not found", { status: 404 });
    });
    const s = store();
    const d = deps(s, fetchMixed as unknown as typeof fetch);
    // No hand-maintained pluginQuotaIds: discovery drives both fetches.
    d.config = parseConfig({ ...baseConfigRaw(), pluginQuotaIds: {} }).config;
    const summary = await runSync(d, { running: false });
    expect(summary.skipped).toBe(false);
    // Each index queried against its own plugin — never cross-fetched.
    expect(quotaUrls).toHaveLength(2);
    const byPlugin = new Map(quotaUrls.map((u) => {
      const parsed = new URL(u);
      return [parsed.pathname.split("/")[4], parsed.searchParams.get("auth_index")];
    }));
    expect(byPlugin.get("quota-a")).toBe("aaaabbbbccccdddd");
    expect(byPlugin.get("quota-b")).toBe("1111222233334444");
    // The conflict is still visible (first-wins provider fallback), but
    // neither fetch failed: fetch errors carry "(plugin …)" with the file ref.
    expect(summary.errors.some((e) => e.includes("conflicting quota plugin ids"))).toBe(true);
    expect(summary.errors.some((e) => e.includes("(plugin "))).toBe(false);
    // Each payload attached to its own account's row.
    const rows = Object.values(s.savedRows as Record<string, AccountUsageRow>);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.limits.some((l) => l.id === "claude:weekly" && l.remainingPercent === 80))).toHaveLength(1);
    expect(rows.filter((r) => r.limits.some((l) => l.id === "claude:5h" && l.remainingPercent === 10))).toHaveLength(1);
    assertNoKeyLeak(s);
  });

  it("treats a failing plugin route as best-effort: passive signals survive", async () => {
    const s = store();
    const summary = await runSync(
      deps(s, mockFetch({ pluginStatus: 500 }) as unknown as typeof fetch),
      { running: false },
    );
    expect(summary.skipped).toBe(false);
    expect(summary.errors.some((e) => e.includes("claude"))).toBe(true);
    const rows = s.savedRows as Record<string, AccountUsageRow>;
    const claude = Object.values(rows).find((r) => r.provider === "claude") as AccountUsageRow;
    // Passive auth-files signal still present for the claude account.
    expect(claude.limits.length).toBeGreaterThan(0);
    assertNoKeyLeak(s);
  });

  it("flags duplicates and unkeyed entries with warnings, keying stably across syncs", async () => {
    const fetchDup = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/management/auth-files") {
        return jsonResponse(200, [
          { id: "dup-1", provider: "claude" },
          { id: "dup-1", provider: "claude" },
          { provider: "claude" },
        ]);
      }
      return new Response("not found", { status: 404 });
    });
    const s = store();
    const d = deps(s, fetchDup as unknown as typeof fetch);
    // Avoid the plugin quota fetch (no pluginQuotaIds match needed) — keep focused.
    d.config = parseConfig({ ...baseConfigRaw(), pluginQuotaIds: {} }).config;
    const summary = await runSync(d, { running: false });
    expect(summary.rowsWritten).toBe(1); // first dup kept, repeat + unkeyed ignored
    expect(summary.errors.some((e) => e.includes("duplicate"))).toBe(true);
    expect(summary.errors.some((e) => e.includes("without a stable id"))).toBe(true);
    const keys = Object.keys(s.savedRows as Record<string, AccountUsageRow>);
    expect(keys).toHaveLength(1);
    // Stable across syncs: same identity → same key.
    const s2 = store();
    const d2 = deps(s2, fetchDup as unknown as typeof fetch);
    d2.config = d.config;
    await runSync(d2, { running: false });
    expect(Object.keys(s2.savedRows as Record<string, AccountUsageRow>)).toEqual(keys);
  });
});

describe("served-model catalog (/v1/models + auth-files)", () => {
  it("derives proven models and persists them on the summary", async () => {
    const s = store();
    const d = deps(s, mockFetch() as unknown as typeof fetch);
    // Devin is in scope via the config row (no devin account discovered):
    // the namespaced id still attributes by namespace despite owned_by.
    d.config = parseConfig({
      ...baseConfigRaw(),
      providers: [
        ...baseConfigRaw().providers,
        { provider: "devin", connectionId: "conn-devin", completeInventory: true },
      ],
    }).config;
    const summary = await runSync(d, { running: false });
    expect(summary.skipped).toBe(false);
    // Bare id via owned_by fallback (no model_quotas in this fixture), and the
    // Devin namespaced id despite owned_by: anthropic.
    expect(summary.providerModels?.claude).toContain("claude-opus-4-5");
    expect(summary.providerModels?.devin).toEqual(["devin/claude-opus-4-5"]);
    expect(summary.modelOverlaps).toEqual([]);
    assertNoKeyLeak(s);
  });

  it("a missing client secret skips the catalog with a warning, sync still succeeds", async () => {
    const s = store();
    const d = deps(s, mockFetch() as unknown as typeof fetch);
    const { config } = parseConfig({ ...baseConfigRaw(), clientApiKeySecretRef: undefined });
    d.config = config;
    const summary = await runSync(d, { running: false });
    expect(summary.skipped).toBe(false);
    expect(summary.errors.some((e) => e.includes("clientApiKeySecretRef"))).toBe(true);
    expect(summary.providerModels).toBeUndefined();
    expect(summary.modelOverlaps).toBeUndefined();
  });

  it("a 401 from /v1/models never spends the management strike budget", async () => {
    const s = store();
    const summary = await runSync(
      deps(s, mockFetch({ modelsStatus: 401 }) as unknown as typeof fetch),
      { running: false },
    );
    expect(summary.skipped).toBe(false); // best-effort: quota aggregation proceeds
    expect(summary.errors.some((e) => e.includes("/v1/models"))).toBe(true);
    expect(s.strike.failures).toHaveLength(0);
    expect(s.strike.secretBad).toBe(false);
    expect(s.strike.disabled).toBe(false);
    assertNoKeyLeak(s);
  });

  it("a colliding bare id becomes model-overlap drift, proven for nobody", async () => {
    const fetchOverlap = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/management/auth-files") {
        return jsonResponse(200, [
          {
            id: "claude-1",
            provider: "claude",
            model_quotas: {
              "shared-bare-model": {
                observed_at: NOW,
                signals: { "anthropic-ratelimit-unified-5h-utilization": "0.2" },
              },
            },
          },
          {
            id: "codex-1",
            provider: "codex",
            model_quotas: {
              "shared-bare-model": {
                observed_at: NOW,
                signals: { "x-codex-primary-used-percent": "10" },
              },
            },
          },
        ]);
      }
      if (url.pathname === "/v1/models") {
        return jsonResponse(200, { data: [{ id: "shared-bare-model", owned_by: "openai" }] });
      }
      return new Response("not found", { status: 404 });
    });
    const s = store();
    const d = deps(s, fetchOverlap as unknown as typeof fetch);
    d.config = parseConfig({
      ...baseConfigRaw(),
      providers: [
        { provider: "claude", connectionId: "conn-claude", completeInventory: true },
        { provider: "codex", connectionId: "conn-codex", completeInventory: true },
      ],
      pluginQuotaIds: {},
    }).config;
    const summary = await runSync(d, { running: false });
    expect(summary.skipped).toBe(false);
    expect(summary.modelOverlaps).toEqual([{ id: "shared-bare-model", providers: ["claude", "codex"] }]);
    expect(summary.providerModels?.claude ?? []).not.toContain("shared-bare-model");
    expect(summary.providerModels?.codex ?? []).not.toContain("shared-bare-model");
    const overlapDrift = (summary.drift ?? []).filter((f) => f.kind === "model-overlap");
    expect(overlapDrift.map((f) => f.provider).sort()).toEqual(["claude", "codex"]);
    expect(summary.errors.some((e) => e.includes("shared-bare-model"))).toBe(true);
  });

  it("flags the canonical overlap from the live served set when antigravity reports no model_quotas", async () => {
    // Stock `claude-sonnet-4-6` is served by both claude and antigravity;
    // antigravity's auth file carries no per-model state for it, so only the
    // per-credential served set reveals the second claim.
    const servedByFile: Record<string, string[]> = {
      "claude-file": ["claude-sonnet-4-6"],
      "antigravity-file": ["claude-sonnet-4-6"],
    };
    const fetchServed = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/management/auth-files") {
        return jsonResponse(200, [
          {
            id: "claude-1",
            name: "claude-file",
            provider: "claude",
            model_quotas: {
              "claude-sonnet-4-6": {
                observed_at: NOW,
                signals: { "anthropic-ratelimit-unified-5h-utilization": "0.2" },
              },
            },
          },
          { id: "antigravity-1", name: "antigravity-file", provider: "antigravity" },
        ]);
      }
      if (url.pathname === "/v0/management/auth-files/models") {
        const name = url.searchParams.get("name") ?? "";
        if (!(name in servedByFile)) return new Response("no such file", { status: 404 });
        return jsonResponse(200, { data: servedByFile[name].map((id) => ({ id })) });
      }
      if (url.pathname === "/v1/models") {
        return jsonResponse(200, { data: [{ id: "claude-sonnet-4-6" }] });
      }
      return new Response("not found", { status: 404 });
    });
    const s = store();
    const d = deps(s, fetchServed as unknown as typeof fetch);
    d.config = parseConfig({
      ...baseConfigRaw(),
      providers: [
        { provider: "claude", connectionId: "conn-claude", completeInventory: true },
        { provider: "antigravity", connectionId: "conn-antigravity", completeInventory: true },
      ],
      pluginQuotaIds: {},
    }).config;
    const summary = await runSync(d, { running: false });
    expect(summary.skipped).toBe(false);
    expect(summary.modelOverlaps).toEqual([
      { id: "claude-sonnet-4-6", providers: ["antigravity", "claude"] },
    ]);
    expect(summary.providerModels?.claude ?? []).not.toContain("claude-sonnet-4-6");
    expect(summary.providerModels?.antigravity ?? []).not.toContain("claude-sonnet-4-6");
    const overlapDrift = (summary.drift ?? []).filter((f) => f.kind === "model-overlap");
    expect(overlapDrift.map((f) => f.provider).sort()).toEqual(["antigravity", "claude"]);
    assertNoKeyLeak(s);
  });

  it("a live served set supersedes a stale model_quotas claim (no false overlap)", async () => {
    // Claude's auth file still carries a `model_quotas` key for
    // `shared-live-model`, but Claude's live served set excludes it while
    // antigravity's live set includes it. Live has spoken for both files, so
    // the stale quota key — and the stale `owned_by: anthropic` fallback —
    // must not fabricate a Claude/antigravity overlap.
    const servedByFile: Record<string, string[]> = {
      "claude-file": ["claude-opus-4-5"],
      "antigravity-file": ["shared-live-model"],
    };
    const fetchSupersede = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/management/auth-files") {
        return jsonResponse(200, [
          {
            id: "claude-1",
            name: "claude-file",
            provider: "claude",
            model_quotas: {
              "claude-opus-4-5": {
                observed_at: NOW,
                signals: { "anthropic-ratelimit-unified-5h-utilization": "0.2" },
              },
              "shared-live-model": {
                observed_at: NOW,
                signals: { "anthropic-ratelimit-unified-5h-utilization": "0.2" },
              },
            },
          },
          { id: "antigravity-1", name: "antigravity-file", provider: "antigravity" },
        ]);
      }
      if (url.pathname === "/v0/management/auth-files/models") {
        const name = url.searchParams.get("name") ?? "";
        if (!(name in servedByFile)) return new Response("no such file", { status: 404 });
        return jsonResponse(200, { data: servedByFile[name].map((id) => ({ id })) });
      }
      if (url.pathname === "/v1/models") {
        return jsonResponse(200, {
          data: [
            { id: "claude-opus-4-5", owned_by: "anthropic" },
            { id: "shared-live-model", owned_by: "anthropic" },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    });
    const s = store();
    const d = deps(s, fetchSupersede as unknown as typeof fetch);
    d.config = parseConfig({
      ...baseConfigRaw(),
      providers: [
        { provider: "claude", connectionId: "conn-claude", completeInventory: true },
        { provider: "antigravity", connectionId: "conn-antigravity", completeInventory: true },
      ],
      pluginQuotaIds: {},
    }).config;
    const summary = await runSync(d, { running: false });
    expect(summary.skipped).toBe(false);
    expect(summary.modelOverlaps).toEqual([]);
    expect(summary.providerModels?.antigravity).toEqual(["shared-live-model"]);
    expect(summary.providerModels?.claude).toEqual(["claude-opus-4-5"]);
    const overlapDrift = (summary.drift ?? []).filter((f) => f.kind === "model-overlap");
    expect(overlapDrift).toEqual([]);
    assertNoKeyLeak(s);
  });

  it("a disabled account's model_quotas cannot fabricate an overlap", async () => {
    // The old Claude credential is disabled but still carries a quota key for
    // the id antigravity live-serves. Disabling the credential must clear its
    // claims: no overlap, antigravity proven.
    const fetchDisabled = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/management/auth-files") {
        return jsonResponse(200, [
          {
            id: "claude-1",
            provider: "claude",
            disabled: true,
            model_quotas: {
              "shared-live-model": {
                observed_at: NOW,
                signals: { "anthropic-ratelimit-unified-5h-utilization": "0.2" },
              },
            },
          },
          { id: "antigravity-1", name: "antigravity-file", provider: "antigravity" },
        ]);
      }
      if (url.pathname === "/v0/management/auth-files/models") {
        if (url.searchParams.get("name") !== "antigravity-file") {
          return new Response("no such file", { status: 404 });
        }
        return jsonResponse(200, { data: [{ id: "shared-live-model" }] });
      }
      if (url.pathname === "/v1/models") {
        return jsonResponse(200, { data: [{ id: "shared-live-model" }] });
      }
      return new Response("not found", { status: 404 });
    });
    const s = store();
    const d = deps(s, fetchDisabled as unknown as typeof fetch);
    d.config = parseConfig({
      ...baseConfigRaw(),
      providers: [
        { provider: "claude", connectionId: "conn-claude", completeInventory: true },
        { provider: "antigravity", connectionId: "conn-antigravity", completeInventory: true },
      ],
      pluginQuotaIds: {},
    }).config;
    const summary = await runSync(d, { running: false });
    expect(summary.skipped).toBe(false);
    expect(summary.modelOverlaps).toEqual([]);
    expect(summary.providerModels?.antigravity).toEqual(["shared-live-model"]);
    const overlapDrift = (summary.drift ?? []).filter((f) => f.kind === "model-overlap");
    expect(overlapDrift).toEqual([]);
    assertNoKeyLeak(s);
  });

  it("a disabled credential's owned_by cannot fabricate an overlap", async () => {
    // Same shape as above, but the catalog attributes the shared id to
    // claude via owned_by. Scope — not quota keys — carries that claim, so
    // disabling the credential must clear it too: no overlap, antigravity
    // proven.
    const fetchOwnedBy = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/management/auth-files") {
        return jsonResponse(200, [
          {
            id: "claude-1",
            provider: "claude",
            disabled: true,
            model_quotas: {
              "shared-live-model": {
                observed_at: NOW,
                signals: { "anthropic-ratelimit-unified-5h-utilization": "0.2" },
              },
            },
          },
          { id: "antigravity-1", name: "antigravity-file", provider: "antigravity" },
        ]);
      }
      if (url.pathname === "/v0/management/auth-files/models") {
        if (url.searchParams.get("name") !== "antigravity-file") {
          return new Response("no such file", { status: 404 });
        }
        return jsonResponse(200, { data: [{ id: "shared-live-model" }] });
      }
      if (url.pathname === "/v1/models") {
        return jsonResponse(200, { data: [{ id: "shared-live-model", owned_by: "anthropic" }] });
      }
      return new Response("not found", { status: 404 });
    });
    const s = store();
    const d = deps(s, fetchOwnedBy as unknown as typeof fetch);
    d.config = parseConfig({
      ...baseConfigRaw(),
      providers: [
        { provider: "claude", connectionId: "conn-claude", completeInventory: true },
        { provider: "antigravity", connectionId: "conn-antigravity", completeInventory: true },
      ],
      pluginQuotaIds: {},
    }).config;
    const summary = await runSync(d, { running: false });
    expect(summary.skipped).toBe(false);
    expect(summary.modelOverlaps).toEqual([]);
    expect(summary.providerModels?.antigravity).toEqual(["shared-live-model"]);
    const overlapDrift = (summary.drift ?? []).filter((f) => f.kind === "model-overlap");
    expect(overlapDrift).toEqual([]);
    assertNoKeyLeak(s);
  });

  it("a 404 served-set endpoint on every file degrades to the heuristic with a warning", async () => {
    const fetchNoServedSet = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/management/auth-files") {
        return jsonResponse(200, [
          { id: "claude-1", name: "claude-file", provider: "claude" },
        ]);
      }
      if (url.pathname === "/v0/management/auth-files/models") {
        return new Response("no such endpoint", { status: 404 });
      }
      if (url.pathname === "/v1/models") {
        return jsonResponse(200, { data: [{ id: "claude-opus-4-5", owned_by: "anthropic" }] });
      }
      return new Response("not found", { status: 404 });
    });
    const s = store();
    const summary = await runSync(deps(s, fetchNoServedSet as unknown as typeof fetch), {
      running: false,
    });
    expect(summary.skipped).toBe(false);
    // Heuristic still proves the id via owned_by; no strike spent on the 404.
    expect(summary.providerModels?.claude).toContain("claude-opus-4-5");
    expect(summary.modelOverlaps).toEqual([]);
    expect(summary.errors.some((e) => e.includes("falls back to the model_quotas"))).toBe(true);
    expect(s.strike.failures).toHaveLength(0);
    assertNoKeyLeak(s);
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
    // "Edited" config: different intervals, different rows — budget must persist.
    const edited = parseConfig({
      ...baseConfigRaw(),
      syncIntervalMinutes: 2,
      reservePercent: 20,
      providers: [{ provider: "claude", connectionId: "conn-claude" }],
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
    const summary = await runSync(deps(s, fetchMock), { running: false });
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
    // Setup-class failures log under the setup_error key, not sync_failed.
    expect(
      s.activity.some(
        (a) =>
          a.message === ACTIVITY_SETUP_ERROR &&
          typeof a.metadata?.summary === "string" &&
          a.metadata.summary.includes("resolved empty"),
      ),
    ).toBe(true);
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
    // …logged under the stable key with the sentence in metadata…
    expect(
      s.activity.some(
        (a) =>
          a.message === ACTIVITY_SYNC_FAILED &&
          typeof a.metadata?.summary === "string" &&
          a.metadata.summary.includes("sync failed"),
      ),
    ).toBe(true);
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

describe("live provider-API quota (pinned api-call templates)", () => {
  const RESET = Math.floor(Date.parse(NOW) / 1000) + 3600;
  const antigravitySubBody = () => ({
    currentTier: { id: "g1-pro-tier", name: "Pro" },
  });
  const antigravityQuotaBody = () => ({
    groups: [{ buckets: [{ window: "daily", remainingFraction: 0.8, resetTime: RESET }] }],
  });
  const devinBody = () => ({
    userStatus: {
      planStatus: {
        dailyQuotaRemainingPercent: 60,
        dailyQuotaResetAtUnix: RESET,
        weeklyQuotaRemainingPercent: 80,
        weeklyQuotaResetAtUnix: RESET + 86400,
        planInfo: { planName: "Devin Pro" },
      },
    },
  });

  function apiFetch(
    calls: string[],
    files: unknown[],
    opts?: {
      transportStatus?: number;
      upstreamStatus?: number;
      quotaUpstreamStatus?: number;
      quotaMode?: "groups" | "empty" | "daily-empty";
    },
  ) {
    return vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/management/auth-files") return jsonResponse(200, files);
      if (url.pathname === "/v1/models") return jsonResponse(200, { data: [] });
      if (url.pathname.includes("/plugins/")) return jsonResponse(200, { groups: [] });
      if (url.pathname === "/v0/management/api-call") {
        if (opts?.transportStatus) return new Response("denied", { status: opts.transportStatus });
        const sent = JSON.parse(String(init?.body)) as { url: string; auth_index: string; data: string };
        calls.push(`${sent.auth_index} ${sent.url}`);
        expect(sent.auth_index).not.toMatch(/api-call/);
        const isQuota = sent.url.includes("retrieveUserQuotaSummary");
        if (isQuota) {
          // The quota body must carry the entry's project id — parsed JSON,
          // never a raw sentinel, never credential material.
          const data = JSON.parse(sent.data) as Record<string, unknown>;
          expect(typeof data.project).toBe("string");
          expect(data.project).not.toBe("PROJECT_ID_SENTINEL");
        }
        const quotaUpstream =
          opts?.quotaMode === "empty" || (opts?.quotaMode === "daily-empty" && !sent.url.includes("sandbox"))
            ? { groups: [] }
            : antigravityQuotaBody();
        const upstream = isQuota
          ? quotaUpstream
          : sent.url.includes("loadCodeAssist")
            ? antigravitySubBody()
            : devinBody();
        const status = isQuota ? (opts?.quotaUpstreamStatus ?? 200) : (opts?.upstreamStatus ?? 200);
        return jsonResponse(200, { status_code: status, header: {}, body: JSON.stringify(upstream) });
      }
      return new Response("not found", { status: 404 });
    });
  }

  function configWith(...providers: Array<{ provider: string; connectionId: string }>) {
    const raw = baseConfigRaw();
    raw.providers = providers.map((p) => ({ ...p, completeInventory: false }));
    return parseConfig(raw).config;
  }

  function depsWith(s: Store, config: ReturnType<typeof parseConfig>["config"], fetchImpl?: typeof fetch) {
    const d = deps(s, fetchImpl);
    return { ...d, config };
  }

  it("calls one pinned template per credential per sync and attaches windows to their own rows", async () => {
    const s = store();
    const calls: string[] = [];
    const files = [
      { id: "ag-a", provider: "antigravity", auth_index: "a1", project_id: "proj-a" },
      { id: "ag-b", provider: "antigravity", auth_index: "a1", project_id: "proj-a" },
      { id: "devin-a", provider: "devin", auth_index: "d1" },
      { id: "claude-a", provider: "claude" },
    ];
    const config = configWith(
      { provider: "claude", connectionId: "conn-claude" },
      { provider: "antigravity", connectionId: "conn-ag" },
      { provider: "devin", connectionId: "conn-devin" },
    );
    const inFlight = { running: false };
    const summary = await runSync(depsWith(s, config, apiFetch(calls, files) as never), inFlight);
    expect(summary.skipped).toBe(false);
    // One subscription call per distinct credential (the two antigravity rows
    // share auth_index a1) plus one winning quota call for that credential.
    expect(calls).toHaveLength(3);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.stringContaining("a1 https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"),
        expect.stringContaining("a1 https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"),
        expect.stringContaining("d1 https://server.codeium.com/"),
      ]),
    );
    const rows = Object.values(s.savedRows ?? {});
    const agRows = rows.filter((r) => r.provider === "antigravity");
    expect(agRows).toHaveLength(2);
    for (const row of agRows) {
      expect(row.quotaBlind).toBe(false);
      expect(row.planType).toBe("Pro");
      expect(row.limits.map((l) => l.id)).toEqual(["antigravity:daily"]);
      expect(row.limits.every((l) => l.viaProviderApi === true)).toBe(true);
    }
    const devinRow = rows.find((r) => r.provider === "devin");
    expect(devinRow?.quotaBlind).toBe(false);
    expect(devinRow?.limits.map((l) => l.id)).toEqual(["devin:daily", "devin:weekly"]);
    assertNoKeyLeak(s);
  });

  it("never calls for meta accounts (panel-only) and says so once", async () => {
    const s = store();
    const calls: string[] = [];
    const files = [
      { id: "meta-a", provider: "meta", auth_index: "m1" },
      { id: "meta-b", provider: "meta", auth_index: "m2" },
    ];
    const config = configWith({ provider: "meta", connectionId: "conn-meta" });
    const summary = await runSync(depsWith(s, config, apiFetch(calls, files) as never), {
      running: false,
    });
    expect(summary.skipped).toBe(false);
    expect(calls).toHaveLength(0);
    const rows = Object.values(s.savedRows ?? {});
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.quotaBlind).toBe(true);
      expect(row.planType).toBeNull();
      expect(row.limits).toEqual([]);
    }
    expect(summary.errors.join(" ")).toMatch(/meta: 2 account\(s\) skipped.*panel-only/);
    assertNoKeyLeak(s);
  });

  it("a disabled kill switch makes no provider call and warns once", async () => {
    const s = store();
    const calls: string[] = [];
    const files = [
      { id: "ag-a", provider: "antigravity", auth_index: "a1", project_id: "proj-a" },
      { id: "devin-a", provider: "devin", auth_index: "d1" },
    ];
    const raw = baseConfigRaw();
    raw.providers = [
      { provider: "antigravity", connectionId: "conn-ag", completeInventory: false },
      { provider: "devin", connectionId: "conn-devin", completeInventory: false },
    ];
    (raw as Record<string, unknown>).apiCallEnabled = { antigravity: false };
    const config = parseConfig(raw).config;
    const summary = await runSync(depsWith(s, config, apiFetch(calls, files) as never), {
      running: false,
    });
    expect(summary.skipped).toBe(false);
    // Only the devin credential called (subscription); the killed antigravity
    // family made no call at all — not even a quota round.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("d1 https://server.codeium.com/");
    expect(summary.errors.join(" ")).toMatch(/live quota disabled by config/);
    const rows = Object.values(s.savedRows ?? {});
    expect(rows.find((r) => r.provider === "devin")?.quotaBlind).toBe(false);
    assertNoKeyLeak(s);
  });

  it("skips disabled and cooling accounts (no probe while the provider says wait)", async () => {
    const s = store();
    const calls: string[] = [];
    const files = [
      { id: "devin-off", provider: "devin", auth_index: "d-off", disabled: true },
      {
        id: "devin-cool",
        provider: "devin",
        auth_index: "d-cool",
        unavailable: true,
        next_retry_after: new Date(Date.parse(NOW) + 3600_000).toISOString(),
      },
      { id: "devin-ok", provider: "devin", auth_index: "d-ok" },
    ];
    const config = configWith({ provider: "devin", connectionId: "conn-devin" });
    await runSync(depsWith(s, config, apiFetch(calls, files) as never), { running: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("d-ok");
  });

  it("a rejected key on the api-call path stops the run and marks the secret bad", async () => {
    const s = store();
    const calls: string[] = [];
    const files = [{ id: "devin-a", provider: "devin", auth_index: "d1" }];
    const config = configWith({ provider: "devin", connectionId: "conn-devin" });
    const summary = await runSync(
      depsWith(s, config, apiFetch(calls, files, { transportStatus: 401 }) as never),
      { running: false },
    );
    expect(summary.skipped).toBe(true);
    expect(s.strike.secretBad).toBe(true);
    expect(s.savedRows).toBeNull();
  });

  it("an upstream provider error warns per file and stays quota-blind (fail open)", async () => {
    const s = store();
    const calls: string[] = [];
    const files = [{ id: "devin-a", provider: "devin", auth_index: "d1" }];
    const config = configWith({ provider: "devin", connectionId: "conn-devin" });
    const summary = await runSync(
      depsWith(s, config, apiFetch(calls, files, { upstreamStatus: 500 }) as never),
      { running: false },
    );
    expect(summary.skipped).toBe(false);
    expect(calls).toHaveLength(1);
    const rows = Object.values(s.savedRows ?? {});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.quotaBlind).toBe(true);
    expect(rows[0]?.limits).toEqual([]);
    expect((summary.errors.join(" ") + (rows[0]?.lastError ?? ""))).toMatch(/500/);
    assertNoKeyLeak(s);
  });

  it("an upstream 401 backs the account off for an hour (no per-sync retry)", async () => {
    const s = store();
    const calls: string[] = [];
    const files = [{ id: "devin-a", provider: "devin", auth_index: "d1" }];
    const config = configWith({ provider: "devin", connectionId: "conn-devin" });
    const apiCallLastCall = new Map<string, number>();
    const apiCallCache = new Map<string, { statusCode: number; body: unknown; observedAt: string }>();
    const apiCallAuthBackoffUntil = new Map<string, number>();
    const base = { apiCallLastCall, apiCallCache, apiCallAuthBackoffUntil };
    const first = await runSync(
      { ...depsWith(s, config, apiFetch(calls, files, { upstreamStatus: 401 }) as never), ...base },
      { running: false },
    );
    expect(first.skipped).toBe(false);
    expect(calls).toHaveLength(1);
    expect(first.errors.join(" ")).toMatch(/backing off for 1 hour/);
    // The 401 payload is never attached, so the parser cannot warn twice:
    // the row carries no parser warning, only the one backoff warning.
    const rows = Object.values(s.savedRows ?? {});
    expect(rows[0]?.quotaBlind).toBe(true);
    expect(rows[0]?.lastError).toBeNull();
    // A minute later the account is parked: no retry, no new warning.
    const later = new Date(Date.parse(NOW) + 60_000).toISOString();
    const second = await runSync(
      {
        ...depsWith(s, config, apiFetch(calls, files, { upstreamStatus: 401 }) as never),
        now: later,
        ...base,
      },
      { running: false },
    );
    expect(second.skipped).toBe(false);
    expect(calls).toHaveLength(1);
    // After the hour the endpoint is re-probed and recovers.
    const after = new Date(Date.parse(NOW) + 61 * 60_000).toISOString();
    const third = await runSync(
      { ...depsWith(s, config, apiFetch(calls, files) as never), now: after, ...base },
      { running: false },
    );
    expect(third.skipped).toBe(false);
    expect(calls).toHaveLength(2);
    expect(Object.values(s.savedRows ?? {})[0]?.quotaBlind).toBe(false);
    assertNoKeyLeak(s);
  });

  it("an upstream 403 on the quota call parks the account with a single warning", async () => {
    const s = store();
    const calls: string[] = [];
    const files = [{ id: "ag-a", provider: "antigravity", auth_index: "a1", project_id: "proj-a" }];
    const config = configWith({ provider: "antigravity", connectionId: "conn-ag" });
    const apiCallLastCall = new Map<string, number>();
    const apiCallCache = new Map<string, { statusCode: number; body: unknown; observedAt: string }>();
    const apiCallAuthBackoffUntil = new Map<string, number>();
    const base = { apiCallLastCall, apiCallCache, apiCallAuthBackoffUntil };
    const first = await runSync(
      {
        ...depsWith(s, config, apiFetch(calls, files, { quotaUpstreamStatus: 403 }) as never),
        ...base,
      },
      { running: false },
    );
    expect(first.skipped).toBe(false);
    // Subscription answered (plan evidence), quota rejected (backoff).
    expect(calls).toHaveLength(2);
    expect(first.errors.join(" ").match(/403/g)).toHaveLength(1);
    expect(first.errors.join(" ")).toMatch(/backing off for 1 hour/);
    const rows = Object.values(s.savedRows ?? {});
    expect(rows[0]?.planType).toBe("Pro");
    expect(rows[0]?.limits).toEqual([]);
    // Parked: the next sync makes no calls at all, not even the subscription.
    const later = new Date(Date.parse(NOW) + 60_000).toISOString();
    await runSync(
      {
        ...depsWith(s, config, apiFetch(calls, files, { quotaUpstreamStatus: 403 }) as never),
        now: later,
        ...base,
      },
      { running: false },
    );
    expect(calls).toHaveLength(2);
    assertNoKeyLeak(s);
  });

  it("never sends fuzzy provider words through a pinned template (no credential to the wrong request)", async () => {
    const s = store();
    const calls: string[] = [];
    // `gemini`/`gemini-cli` fuzzy-match to antigravity and `metafoo` contains
    // `meta` under substring matching: none of them may produce an api-call.
    const files = [
      { id: "gemini-a", provider: "gemini", auth_index: "g1" },
      { id: "gemini-cli-a", provider: "gemini-cli", auth_index: "g2" },
      { id: "metafoo-a", provider: "metafoo", auth_index: "mX" },
    ];
    const config = configWith(
      { provider: "gemini", connectionId: "conn-gemini" },
      { provider: "gemini-cli", connectionId: "conn-gemini-cli" },
      { provider: "metafoo", connectionId: "conn-metafoo" },
    );
    const summary = await runSync(depsWith(s, config, apiFetch(calls, files) as never), {
      running: false,
    });
    expect(summary.skipped).toBe(false);
    expect(calls).toHaveLength(0);
    const rows = Object.values(s.savedRows ?? {});
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.limits.every((l) => l.viaProviderApi !== true))).toBe(true);
    assertNoKeyLeak(s);
  });

  it("a throttled rerun reuses the cached answers with the first run's observedAt", async () => {
    const s = store();
    const calls: string[] = [];
    const files = [
      { id: "ag-a", provider: "antigravity", auth_index: "a1", project_id: "proj-a" },
      { id: "devin-a", provider: "devin", auth_index: "d1" },
    ];
    const config = configWith(
      { provider: "antigravity", connectionId: "conn-ag" },
      { provider: "devin", connectionId: "conn-devin" },
    );
    const apiCallLastCall = new Map<string, number>();
    const apiCallCache = new Map<string, { statusCode: number; body: unknown; observedAt: string }>();
    const first = await runSync(
      { ...depsWith(s, config, apiFetch(calls, files) as never), apiCallLastCall, apiCallCache },
      { running: false },
    );
    expect(first.skipped).toBe(false);
    // Two subscription calls plus one winning quota call.
    expect(calls).toHaveLength(3);
    // A minute later the throttle holds, but the live windows survive with
    // the first run's observation time — not a fresh stamp, not blank.
    const later = new Date(Date.parse(NOW) + 60_000).toISOString();
    const second = await runSync(
      {
        ...depsWith(s, config, apiFetch(calls, files) as never),
        now: later,
        apiCallLastCall,
        apiCallCache,
      },
      { running: false },
    );
    expect(second.skipped).toBe(false);
    expect(calls).toHaveLength(3);
    const origin = new URL("http://127.0.0.1:8317").origin;
    expect([...apiCallLastCall.keys()].sort()).toEqual([`${origin} a1`, `${origin} d1`]);
    const rows = Object.values(s.savedRows ?? {});
    const agRow = rows.find((r) => r.provider === "antigravity");
    expect(agRow?.quotaBlind).toBe(false);
    expect(agRow?.limits.map((l) => l.id)).toEqual(["antigravity:daily"]);
    expect(agRow?.limits.every((l) => l.viaProviderApi === true)).toBe(true);
    expect(agRow?.limits.every((l) => l.observedAt === NOW)).toBe(true);
    const devinRow = rows.find((r) => r.provider === "devin");
    expect(devinRow?.quotaBlind).toBe(false);
    expect(devinRow?.limits.every((l) => l.observedAt === NOW)).toBe(true);
    assertNoKeyLeak(s);
  });

  it("two runs 4m59s apart both call (cron jitter tolerance)", async () => {
    const s = store();
    const calls: string[] = [];
    const files = [{ id: "devin-a", provider: "devin", auth_index: "d1" }];
    const config = configWith({ provider: "devin", connectionId: "conn-devin" });
    const apiCallLastCall = new Map<string, number>();
    const apiCallCache = new Map<string, { statusCode: number; body: unknown; observedAt: string }>();
    const first = await runSync(
      { ...depsWith(s, config, apiFetch(calls, files) as never), apiCallLastCall, apiCallCache },
      { running: false },
    );
    expect(first.skipped).toBe(false);
    expect(calls).toHaveLength(1);
    const later = new Date(Date.parse(NOW) + (4 * 60 + 59) * 1000).toISOString();
    const second = await runSync(
      {
        ...depsWith(s, config, apiFetch(calls, files) as never),
        now: later,
        apiCallLastCall,
        apiCallCache,
      },
      { running: false },
    );
    expect(second.skipped).toBe(false);
    expect(calls).toHaveLength(2);
    const rows = Object.values(s.savedRows ?? {});
    expect(rows.find((r) => r.provider === "devin")?.quotaBlind).toBe(false);
    assertNoKeyLeak(s);
  });

  it("two companies on the same origin share one call and both get windows", async () => {
    const sA = store();
    const sB = store();
    const calls: string[] = [];
    const files = [{ id: "devin-a", provider: "devin", auth_index: "d1" }];
    const config = configWith({ provider: "devin", connectionId: "conn-devin" });
    const apiCallLastCall = new Map<string, number>();
    const apiCallCache = new Map<string, { statusCode: number; body: unknown; observedAt: string }>();
    const base = { apiCallLastCall, apiCallCache };
    const first = await runSync(
      { ...depsWith(sA, config, apiFetch(calls, files) as never), companyId: "co-a", ...base },
      { running: false },
    );
    expect(first.skipped).toBe(false);
    expect(calls).toHaveLength(1);
    const second = await runSync(
      { ...depsWith(sB, config, apiFetch(calls, files) as never), companyId: "co-b", ...base },
      { running: false },
    );
    expect(second.skipped).toBe(false);
    // One call between them; the second company reuses the cached answer.
    expect(calls).toHaveLength(1);
    for (const s of [sA, sB]) {
      const rows = Object.values(s.savedRows ?? {});
      const devinRow = rows.find((r) => r.provider === "devin");
      expect(devinRow?.quotaBlind).toBe(false);
      expect(devinRow?.limits.map((l) => l.id)).toEqual(["devin:daily", "devin:weekly"]);
      expect(devinRow?.limits.every((l) => l.observedAt === NOW)).toBe(true);
    }
    assertNoKeyLeak(sA);
    assertNoKeyLeak(sB);
  });

  it("tries the remembered quota URL first after one discovery round", async () => {
    const s = store();
    const calls: string[] = [];
    const files = [{ id: "ag-a", provider: "antigravity", auth_index: "a1", project_id: "proj-a" }];
    const config = configWith({ provider: "antigravity", connectionId: "conn-ag" });
    const apiCallLastCall = new Map<string, number>();
    const apiCallCache = new Map<string, { statusCode: number; body: unknown; observedAt: string }>();
    const apiCallQuotaChoice = new Map<string, string>();
    const quotaCalls = () => calls.filter((c) => c.includes("retrieveUserQuotaSummary"));
    const first = await runSync(
      {
        ...depsWith(s, config, apiFetch(calls, files, { quotaMode: "daily-empty" }) as never),
        apiCallLastCall,
        apiCallCache,
        apiCallQuotaChoice,
      },
      { running: false },
    );
    expect(first.skipped).toBe(false);
    // Discovery: daily answers groupless, sandbox wins.
    expect(quotaCalls()).toHaveLength(2);
    const origin = new URL("http://127.0.0.1:8317").origin;
    expect(apiCallQuotaChoice.get(`${origin} a1`)).toBe("antigravity-quota-sandbox");
    // Next round (throttle cleared, choice kept): subscription plus the
    // remembered sandbox URL only — no second daily call.
    apiCallLastCall.clear();
    const second = await runSync(
      {
        ...depsWith(s, config, apiFetch(calls, files, { quotaMode: "daily-empty" }) as never),
        apiCallLastCall,
        apiCallCache,
        apiCallQuotaChoice,
      },
      { running: false },
    );
    expect(second.skipped).toBe(false);
    expect(quotaCalls()).toHaveLength(3);
    expect(quotaCalls()[2]).toContain("sandbox.googleapis.com");
    const rows = Object.values(s.savedRows ?? {});
    expect(rows[0]?.quotaBlind).toBe(false);
    expect(rows[0]?.limits.map((l) => l.id)).toEqual(["antigravity:daily"]);
    // A throttled third run reuses the remembered winner's groups — the
    // stale groupless daily entry cached during discovery never shadows it.
    const later = new Date(Date.parse(NOW) + 60_000).toISOString();
    const third = await runSync(
      {
        ...depsWith(s, config, apiFetch(calls, files, { quotaMode: "daily-empty" }) as never),
        now: later,
        apiCallLastCall,
        apiCallCache,
        apiCallQuotaChoice,
      },
      { running: false },
    );
    expect(third.skipped).toBe(false);
    expect(quotaCalls()).toHaveLength(3);
    const rows3 = Object.values(s.savedRows ?? {});
    expect(rows3[0]?.quotaBlind).toBe(false);
    expect(rows3[0]?.limits.map((l) => l.id)).toEqual(["antigravity:daily"]);
    expect(rows3[0]?.lastError).toBeNull();
    assertNoKeyLeak(s);
  });

  it("an antigravity account without a project id makes no quota call (plan only)", async () => {
    const s = store();
    const calls: string[] = [];
    const files = [{ id: "ag-a", provider: "antigravity", auth_index: "a1" }];
    const config = configWith({ provider: "antigravity", connectionId: "conn-ag" });
    const summary = await runSync(depsWith(s, config, apiFetch(calls, files) as never), {
      running: false,
    });
    expect(summary.skipped).toBe(false);
    // Subscription only; the quota body cannot be shaped without a project id.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("loadCodeAssist");
    const rows = Object.values(s.savedRows ?? {});
    expect(rows[0]?.planType).toBe("Pro");
    expect(rows[0]?.limits).toEqual([]);
    expect(rows[0]?.lastError ?? "").toMatch(/no project id/);
    assertNoKeyLeak(s);
  });

  it("an unusable project id is never sent upstream", async () => {
    const hostile = "proj\"with'quotes and space";
    const s = store();
    const calls: string[] = [];
    const files = [{ id: "ag-a", provider: "antigravity", auth_index: "a1", project_id: hostile }];
    const config = configWith({ provider: "antigravity", connectionId: "conn-ag" });
    const summary = await runSync(depsWith(s, config, apiFetch(calls, files) as never), {
      running: false,
    });
    expect(summary.skipped).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("loadCodeAssist");
    expect(summary.errors.join(" ")).toMatch(/unusable project id/);
    // The hostile value never lands in a warning, error or row.
    expect(summary.errors.join(" ")).not.toContain(hostile);
    expect(JSON.stringify(s.savedRows)).not.toContain(hostile);
    assertNoKeyLeak(s);
  });

  it("groupless quota answers attach honestly instead of staying quiet", async () => {
    const s = store();
    const calls: string[] = [];
    const files = [{ id: "ag-a", provider: "antigravity", auth_index: "a1", project_id: "proj-a" }];
    const config = configWith({ provider: "antigravity", connectionId: "conn-ag" });
    const summary = await runSync(
      depsWith(s, config, apiFetch(calls, files, { quotaMode: "empty" }) as never),
      { running: false },
    );
    expect(summary.skipped).toBe(false);
    // Subscription plus all three quota URLs, all groupless.
    expect(calls).toHaveLength(4);
    const rows = Object.values(s.savedRows ?? {});
    expect(rows[0]?.lastError ?? "").toMatch(/carries no quota groups/);
    expect(rows[0]?.planType).toBe("Pro");
    expect(rows[0]?.limits).toEqual([]);
    expect(rows[0]?.quotaBlind).toBe(true);
    assertNoKeyLeak(s);
  });

  it("localhost and 127.0.0.1 spellings share one throttle bucket", () => {
    expect(apiCallOriginKey("http://localhost:8317")).toBe("http://127.0.0.1:8317");
    expect(apiCallOriginKey("http://127.0.0.1:8317")).toBe("http://127.0.0.1:8317");
    expect(apiCallOriginKey("http://localhost:8317")).toBe(
      apiCallOriginKey("HTTP://127.0.0.1:8317/"),
    );
    // A different port is a different CLIProxy: never shared.
    expect(apiCallOriginKey("http://localhost:8318")).not.toBe(
      apiCallOriginKey("http://localhost:8317"),
    );
  });
});

describe("stable activity keys + state-change logging", () => {
  const HOUR = 60 * 60_000;

  function driftConfig(
    providers: Array<{ provider: string; connectionId: string }>,
    extra?: Record<string, unknown>,
  ) {
    return parseConfig({
      ...baseConfigRaw(),
      providers: providers.map((p) => ({ ...p, completeInventory: true })),
      pluginQuotaIds: {},
      ...extra,
    }).config;
  }

  /** Auth-files fetch with no plugin quota, catalog or served-set traffic. */
  function driftFetch(files: unknown[], status = 200) {
    return vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/management/auth-files") {
        if (status !== 200) return new Response("boom", { status });
        return jsonResponse(200, files);
      }
      if (url.pathname === "/v1/models") return jsonResponse(200, { data: [] });
      return new Response("not found", { status: 404 });
    });
  }

  const claudeOnly = driftConfig([{ provider: "claude", connectionId: "conn-claude" }]);
  const claudeFiles = [{ id: "c1", provider: "claude" }];
  const kimiFiles = [...claudeFiles, { id: "k1", provider: "kimi" }];

  function runAt(s: Store, files: unknown[], now: string, status = 200) {
    const d = deps(s, driftFetch(files, status) as unknown as typeof fetch);
    return runSync({ ...d, config: claudeOnly, now }, { running: false });
  }

  it("upgrade seeding: existing drift + no ledger logs nothing, but seeds", async () => {
    const s = store();
    expect(s.ledger).toBeNull();
    const first = await runAt(s, kimiFiles, NOW);
    expect(first.skipped).toBe(false);
    expect(first.drift.map((d) => d.kind)).toEqual(["unconfigured-provider"]);
    // No burst for pre-existing findings…
    expect(s.activity).toEqual([]);
    // …but the ledger is seeded as notified now (null becomes non-null)…
    expect(s.ledger).not.toBeNull();
    expect(Object.keys(s.ledger ?? {})).toHaveLength(1);
    // …so the next identical sync stays silent too.
    await runAt(s, kimiFiles, new Date(Date.parse(NOW) + HOUR).toISOString());
    expect(s.activity).toEqual([]);
    assertNoKeyLeak(s);
  });

  it("repeated identical syncs write zero additional activity rows", async () => {
    const s = store();
    const first = await runAt(s, kimiFiles, NOW);
    expect(first.skipped).toBe(false);
    // First run after upgrade seeds silently (see above): no rows at all.
    expect(s.activity).toHaveLength(0);
    // Same findings on the next syncs: silence.
    await runAt(s, kimiFiles, new Date(Date.parse(NOW) + HOUR).toISOString());
    await runAt(s, kimiFiles, new Date(Date.parse(NOW) + 2 * HOUR).toISOString());
    expect(s.activity).toHaveLength(0);
    assertNoKeyLeak(s);
  });

  it("newly appearing drift logs exactly one drift_detected", async () => {
    const s = store();
    const clean = await runAt(s, claudeFiles, NOW);
    expect(clean.skipped).toBe(false);
    expect(clean.drift).toEqual([]);
    expect(s.activity).toEqual([]);
    const drifted = await runAt(s, kimiFiles, new Date(Date.parse(NOW) + HOUR).toISOString());
    expect(drifted.drift.map((d) => d.kind)).toEqual(["unconfigured-provider"]);
    expect(s.activity).toHaveLength(1);
    expect(s.activity[0]?.message).toBe(ACTIVITY_DRIFT_DETECTED);
    expect(s.activity[0]?.metadata?.event).toBe(ACTIVITY_DRIFT_DETECTED);
    expect(s.activity[0]?.metadata?.provider).toBe("kimi");
    expect(s.activity[0]?.metadata?.kind).toBe("unconfigured-provider");
    expect(typeof s.activity[0]?.metadata?.detail).toBe("string");
    expect(typeof s.activity[0]?.metadata?.driftKey).toBe("string");
    assertNoKeyLeak(s);
  });

  it("cleared drift logs exactly one drift_cleared", async () => {
    const s = store();
    await runAt(s, kimiFiles, NOW); // seeds silently
    expect(s.activity).toHaveLength(0);
    const cleared = await runAt(s, claudeFiles, new Date(Date.parse(NOW) + HOUR).toISOString());
    expect(cleared.drift).toEqual([]);
    expect(s.activity).toHaveLength(1);
    expect(s.activity[0]?.message).toBe(ACTIVITY_DRIFT_CLEARED);
    expect(s.activity[0]?.metadata?.provider).toBe("kimi");
    // The key is gone from the ledger: a later reappearance detects anew.
    await runAt(s, kimiFiles, new Date(Date.parse(NOW) + 2 * HOUR).toISOString());
    expect(s.activity).toHaveLength(2);
    expect(s.activity[1]?.message).toBe(ACTIVITY_DRIFT_DETECTED);
    assertNoKeyLeak(s);
  });

  it("accepting a standing finding drops it silently (no drift_cleared)", async () => {
    const s = store();
    await runAt(s, kimiFiles, NOW); // seeds silently
    expect(s.activity).toHaveLength(0);
    expect(Object.keys(s.ledger ?? {})).toHaveLength(1);
    // Ignore kimi: the finding moves to acceptedDrift, leaves the ledger
    // silently, and writes no feed row (not drift_cleared).
    const ignored = driftConfig([{ provider: "claude", connectionId: "conn-claude" }], {
      ignoredProviders: ["kimi"],
    });
    const dIgnored = deps(s, driftFetch(kimiFiles) as unknown as typeof fetch);
    dIgnored.config = ignored;
    const accepted = await runSync(
      { ...dIgnored, now: new Date(Date.parse(NOW) + HOUR).toISOString() },
      { running: false },
    );
    expect(accepted.skipped).toBe(false);
    expect(accepted.drift).toEqual([]);
    expect((accepted.acceptedDrift ?? []).map((d) => d.provider)).toEqual(["kimi"]);
    expect(s.activity).toEqual([]);
    expect(s.ledger).not.toBeNull();
    expect(Object.keys(s.ledger ?? {})).toHaveLength(0);
    // Un-ignoring re-detects exactly once (symmetric case, desirable).
    const redetected = await runAt(s, kimiFiles, new Date(Date.parse(NOW) + 2 * HOUR).toISOString());
    expect(redetected.drift.map((d) => d.provider)).toEqual(["kimi"]);
    expect(s.activity).toHaveLength(1);
    expect(s.activity[0]?.message).toBe(ACTIVITY_DRIFT_DETECTED);
    expect(s.activity[0]?.metadata?.provider).toBe("kimi");
    assertNoKeyLeak(s);
  });

  it("a persistent finding reminds at most once per 24 h", async () => {
    const s = store();
    await runAt(s, kimiFiles, NOW); // seeds silently (lastLoggedAt = NOW)
    expect(s.activity).toHaveLength(0);
    // 23 h later: still present, no reminder yet — but lastSeenAt advances.
    await runAt(s, kimiFiles, new Date(Date.parse(NOW) + 23 * HOUR).toISOString());
    expect(s.activity).toHaveLength(0);
    // 25 h after the seeding: exactly one reminder row.
    await runAt(s, kimiFiles, new Date(Date.parse(NOW) + 25 * HOUR).toISOString());
    expect(s.activity).toHaveLength(1);
    expect(s.activity[0]?.message).toBe(ACTIVITY_DRIFT_STILL_PRESENT);
    expect(s.activity[0]?.metadata?.event).toBe(ACTIVITY_DRIFT_STILL_PRESENT);
    expect(s.activity[0]?.metadata?.provider).toBe("kimi");
    // The reminder resets the clock: 23 h after it, silence again.
    await runAt(s, kimiFiles, new Date(Date.parse(NOW) + 48 * HOUR).toISOString());
    expect(s.activity).toHaveLength(1);
    assertNoKeyLeak(s);
  });

  it("a repeated identical sync failure logs once, then at most a daily reminder", async () => {
    const s = store();
    await runAt(s, kimiFiles, NOW, 500);
    expect(s.activity).toHaveLength(1);
    expect(s.activity[0]?.message).toBe(ACTIVITY_SYNC_FAILED);
    expect(s.failure?.failureKind).toBe("sync-error");
    // Same failure an hour later: no new row, but the attempt refreshes.
    await runAt(s, kimiFiles, new Date(Date.parse(NOW) + HOUR).toISOString(), 500);
    expect(s.activity).toHaveLength(1);
    expect(s.failure?.attemptedAt).toBe(new Date(Date.parse(NOW) + HOUR).toISOString());
    // Same failure 25 h after the first row: one reminder row, then silence.
    await runAt(s, kimiFiles, new Date(Date.parse(NOW) + 25 * HOUR).toISOString(), 500);
    expect(s.activity).toHaveLength(2);
    expect(s.activity[1]?.message).toBe(ACTIVITY_SYNC_FAILED);
    expect(s.activity[1]?.metadata?.reminder).toBe(true);
    await runAt(s, kimiFiles, new Date(Date.parse(NOW) + 26 * HOUR).toISOString(), 500);
    expect(s.activity).toHaveLength(2);
    assertNoKeyLeak(s);
  });

  it("a new failure signature logs anew; recovery logs exactly one sync_recovered", async () => {
    const s = store();
    await runAt(s, kimiFiles, NOW, 500);
    expect(s.activity).toHaveLength(1);
    // A success after the recorded failure: the failed run never reached
    // drift, so this run seeds the drift ledger silently — plus exactly one
    // recovery row — then the failure clears.
    const recovered = await runAt(s, kimiFiles, new Date(Date.parse(NOW) + HOUR).toISOString());
    expect(recovered.skipped).toBe(false);
    expect(s.activity.map((a) => a.message)).toEqual([
      ACTIVITY_SYNC_FAILED,
      ACTIVITY_SYNC_RECOVERED,
    ]);
    expect(s.activity[1]?.metadata?.failureKind).toBe("sync-error");
    expect(typeof s.activity[1]?.metadata?.error).toBe("string");
    expect(s.failure).toBeNull();
    // Steady-state success: silence (and no repeated recovery rows).
    await runAt(s, kimiFiles, new Date(Date.parse(NOW) + 2 * HOUR).toISOString());
    expect(s.activity).toHaveLength(2);
    assertNoKeyLeak(s);
  });

  it("a setup-class failure logs once under setup_error, then recovers once", async () => {
    const s = store();
    const d = deps(s, driftFetch(kimiFiles) as unknown as typeof fetch);
    d.resolveSecret = async () => {
      throw new Error("no such grant");
    };
    await runSync({ ...d, config: claudeOnly, now: NOW }, { running: false });
    expect(s.activity).toHaveLength(1);
    expect(s.activity[0]?.message).toBe(ACTIVITY_SETUP_ERROR);
    expect(s.activity[0]?.metadata?.event).toBe(ACTIVITY_SETUP_ERROR);
    expect(typeof s.activity[0]?.metadata?.error).toBe("string");
    // Identical setup failure an hour later: silent (attempt refreshes).
    await runSync(
      { ...d, now: new Date(Date.parse(NOW) + HOUR).toISOString() },
      { running: false },
    );
    expect(s.activity).toHaveLength(1);
    // A success afterwards recovers exactly once (drift seeds silently).
    const ok = deps(s, driftFetch(kimiFiles) as unknown as typeof fetch);
    await runSync({ ...ok, config: claudeOnly, now: new Date(Date.parse(NOW) + 2 * HOUR).toISOString() }, { running: false });
    expect(s.activity.map((a) => a.message)).toEqual([
      ACTIVITY_SETUP_ERROR,
      ACTIVITY_SYNC_RECOVERED,
    ]);
    expect(s.failure).toBeNull();
    assertNoKeyLeak(s);
  });

  it("every activity message is a stable key and carries the sentence in metadata", async () => {
    const s = store();
    await runAt(s, kimiFiles, NOW); // seeds silently
    await runAt(s, kimiFiles, new Date(Date.parse(NOW) + HOUR).toISOString(), 500); // failed
    await runAt(s, kimiFiles, new Date(Date.parse(NOW) + 2 * HOUR).toISOString()); // recovered
    await runAt(s, kimiFiles, new Date(Date.parse(NOW) + 30 * HOUR).toISOString()); // reminder
    await runAt(s, claudeFiles, new Date(Date.parse(NOW) + 31 * HOUR).toISOString()); // cleared
    expect(s.activity.map((a) => a.message)).toEqual([
      ACTIVITY_SYNC_FAILED,
      ACTIVITY_SYNC_RECOVERED,
      ACTIVITY_DRIFT_STILL_PRESENT,
      ACTIVITY_DRIFT_CLEARED,
    ]);
    for (const entry of s.activity) {
      expect(entry.message).toMatch(/^cliproxy_connector\.[a-z_]+$/);
      expect(entry.metadata?.event).toBe(entry.message);
      expect(typeof entry.metadata?.summary).toBe("string");
      expect((entry.metadata?.summary as string).length).toBeGreaterThan(0);
    }
    // No secret, raw-name or auth-index material rides along in metadata.
    const metadataBlob = JSON.stringify(s.activity.map((a) => a.metadata));
    expect(metadataBlob).not.toContain(KEY);
    expect(metadataBlob).not.toContain("auths/");
    assertNoKeyLeak(s);
  });

  it("a simulated day at 5-minute syncs with 7 standing findings emits <= 7 rows", async () => {
    const s = store();
    const FIVE_MIN = 5 * 60_000;
    const base = Date.parse(NOW);
    // Seven standing unconfigured-provider findings (claude mapped, seven not).
    const others = ["kimi", "xai", "openrouter", "meta", "antigravity", "devin", "zai"];
    const files = [{ id: "c1", provider: "claude" }, ...others.map((p, i) => ({ id: `u${i}`, provider: p }))];
    const d = deps(s, driftFetch(files) as unknown as typeof fetch);
    d.config = claudeOnly;
    // 289 syncs: t=0 seed (silent) … t=24h fires one reminder per finding.
    for (let k = 0; k <= 288; k += 1) {
      d.now = new Date(base + k * FIVE_MIN).toISOString();
      const summary = await runSync(d, { running: false });
      expect(summary.skipped).toBe(false);
      expect(summary.drift).toHaveLength(7);
    }
    expect(s.activity.length).toBeLessThanOrEqual(7);
    for (const entry of s.activity) {
      expect(entry.message).toMatch(/^cliproxy_connector\.[a-z_]+$/);
    }
    assertNoKeyLeak(s);
  }, 30_000);

  it("an ignored provider produces no finding and no log row", async () => {
    const s = store();
    const d = deps(s, driftFetch(kimiFiles) as unknown as typeof fetch);
    d.config = driftConfig([{ provider: "claude", connectionId: "conn-claude" }], {
      // Normalised like the rest of config (provider words are lowercase).
      ignoredProviders: [" KIMI "],
    });
    const summary = await runSync(d, { running: false });
    expect(summary.skipped).toBe(false);
    expect(summary.drift).toEqual([]);
    expect(summary.acceptedDrift).toEqual([
      expect.objectContaining({ kind: "unconfigured-provider", provider: "kimi" }),
    ]);
    expect(s.activity).toEqual([]);
    assertNoKeyLeak(s);
  });

  it("an ignored auth-file ref produces no finding and no log row", async () => {
    const { hashIdentity } = await import("./parsers.js");
    const evilName = "auths/subscription-pool/manifest.json";
    const hash = hashIdentity([evilName])?.slice(0, 8) as string;
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
    for (const ref of [`auth file ${hash}`, hash]) {
      const s = store();
      const d = deps(
        s,
        driftFetch([{ id: "stale-1", provider: "claude", name: evilName }] as unknown[]) as unknown as typeof fetch,
      );
      d.config = driftConfig([{ provider: "claude", connectionId: "conn-claude" }], {
        ignoredAuthFileRefs: [ref],
      });
      const summary = await runSync(d, { running: false });
      expect(summary.skipped).toBe(false);
      expect(summary.drift).toEqual([]);
      expect(summary.acceptedDrift).toEqual([
        expect.objectContaining({ kind: "untrusted-auth-file" }),
      ]);
      expect(s.activity).toEqual([]);
      assertNoKeyLeak(s);
    }
  });

  it("a non-ignored auth-file ref still drifts and logs", async () => {
    const s = store();
    const evil = [{ id: "stale-1", provider: "claude", name: "auths/subscription-pool/manifest.json" }];
    await runAt(s, claudeFiles, NOW); // seeds the (empty) ledger silently
    expect(s.activity).toEqual([]);
    const summary = await runAt(s, evil, new Date(Date.parse(NOW) + HOUR).toISOString());
    expect(summary.skipped).toBe(false);
    expect(summary.drift.map((d) => d.kind)).toEqual(["untrusted-auth-file"]);
    expect(summary.acceptedDrift ?? []).toEqual([]);
    expect(s.activity).toHaveLength(1);
    expect(s.activity[0]?.message).toBe(ACTIVITY_DRIFT_DETECTED);
    assertNoKeyLeak(s);
  });
});
