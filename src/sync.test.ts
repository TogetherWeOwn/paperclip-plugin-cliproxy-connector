import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "./config.js";
import {
  emptyStrikeBudget,
  reenableAfterStrike,
  runSync,
  type SyncDeps,
} from "./sync.js";
import type { AccountUsageRow, StrikeBudgetState, SyncFailure, SyncSummary } from "./types.js";

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
