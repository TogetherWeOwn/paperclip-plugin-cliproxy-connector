import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";
import { buildPageData, buildWidgetData, resetIn } from "./ui-data.js";
import type { AccountUsageRow, StrikeBudgetState, SyncSummary } from "./types.js";

const NOW = "2026-11-01T12:00:00.000Z";

function row(over: Partial<AccountUsageRow> & { prefix: string }): AccountUsageRow {
  return {
    connectionId: `conn-${over.prefix}`,
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

function args(over: Record<string, unknown> = {}) {
  const { config } = parseConfig({
    cliproxyBaseUrl: "http://127.0.0.1:8317",
    managementKeyHeader: "X-K",
    managementSecretRef: { uid: "secret-ref-uid-do-not-leak" },
    prefixMap: {},
    audienceConfirmed: true,
  });
  return {
    now: NOW,
    config,
    rows: {} as Record<string, AccountUsageRow>,
    lastSync: null as SyncSummary | null,
    strike: {
      failures: [],
      disabled: false,
      disabledAt: null,
      disabledReason: null,
      secretBad: false,
    } as StrikeBudgetState,
    ...over,
  };
}

describe("resetIn", () => {
  it("formats countdowns", () => {
    expect(resetIn(null, 0)).toBeNull();
    expect(resetIn("2026-11-01T12:05:00.000Z", Date.parse(NOW))).toBe("5m");
    expect(resetIn("2026-11-01T14:30:00.000Z", Date.parse(NOW))).toBe("2h 30m");
    expect(resetIn("2026-11-01T11:00:00.000Z", Date.parse(NOW))).toBe("now");
  });
});

describe("buildPageData", () => {
  it("classifies freshness and surfaces the earliest reset", () => {
    const page = buildPageData(
      args({
        rows: {
          a: row({
            prefix: "a",
            checkedAt: NOW,
            limits: [
              {
                id: "w",
                label: "w",
                usedPercent: 20,
                remainingPercent: 80,
                resetsAt: "2026-11-01T13:00:00.000Z",
                limitReached: false,
                allowed: true,
                gating: true,
              },
            ],
          }),
          b: row({ prefix: "b", checkedAt: "2026-11-01T11:40:00.000Z" }), // 20 min: stale
          c: row({ prefix: "c", checkedAt: "2026-11-01T10:00:00.000Z" }), // expired
          d: row({ prefix: "d", checkedAt: "not-a-date" }), // missing
        },
      }),
    );
    const byId = Object.fromEntries(page.accounts.map((a) => [a.prefix, a]));
    expect(byId.a.freshness).toBe("fresh");
    expect(byId.b.freshness).toBe("stale");
    expect(byId.c.freshness).toBe("expired");
    expect(byId.d.freshness).toBe("missing");
    expect(byId.a.limits[0].resetIn).toBe("1h 0m");
    expect(byId.b.limits).toEqual([]);
    expect(page.earliestReset).toBe("2026-11-01T13:00:00.000Z");
  });

  it("emits copy-paste snippets and suggested profile models without key material", () => {
    const page = buildPageData(args({ rows: { a: row({ prefix: "a" }) } }));
    expect(page.accounts[0].suggestedProfileModel).toBe("a/<model-id-as-listed>");
    expect(page.accounts[0].connectionSnippet).toContain("a/<model-id-as-listed>");
    // The management secret_ref must never reach page data; only the boolean
    // secretBad flag is exposed. ("secret" as a word is fine — the flag and
    // audience notice use it; the ref value must not appear.)
    const blob = JSON.stringify(page);
    expect(blob).not.toContain("secret-ref-uid");
    expect(typeof page.strike.secretBad).toBe("boolean");
  });

  it("keeps the audience notice until the operator confirms", () => {
    const unconfirmed = parseConfig({
      cliproxyBaseUrl: "http://127.0.0.1:8317",
      managementKeyHeader: "X-K",
      managementSecretRef: { uid: "s" },
      prefixMap: {},
    });
    const page = buildPageData(args({ config: unconfirmed.config }));
    expect(page.audienceConfirmed).toBe(false);
    expect(page.audienceNotice).toMatch(/Confirm which company roles/);
  });
});

describe("buildWidgetData", () => {
  it("reports healthy, drift, empty and disabled states", () => {
    const healthy = buildWidgetData(args({ rows: { a: row({ prefix: "a" }) } }));
    expect(healthy).toMatchObject({ ok: true, status: "healthy", accounts: 1 });

    const lastSync = {
      accountsSeen: 0,
      rowsWritten: 0,
      drift: [{ kind: "unmapped-account", prefix: "x", detail: "d" }],
      errors: [],
      skipped: false,
      skipReason: null,
      startedAt: NOW,
      finishedAt: NOW,
    } as SyncSummary;
    const drifted = buildWidgetData(args({ lastSync }));
    expect(drifted.status).toMatch(/1 drift finding/);

    const empty = buildWidgetData(args({}));
    expect(empty.status).toBe("no accounts synced yet");

    const disabled = buildWidgetData(
      args({
        strike: { failures: [], disabled: true, disabledAt: NOW, disabledReason: "spent", secretBad: true },
      }),
    );
    expect(disabled).toMatchObject({ ok: false, status: "disabled (strike budget spent)" });
  });

  it("counts quota-blind and stale accounts", () => {
    const w = buildWidgetData(
      args({
        rows: {
          a: row({ prefix: "a", quotaBlind: true }),
          b: row({ prefix: "b", checkedAt: "2026-11-01T11:40:00.000Z" }),
        },
      }),
    );
    expect(w.quotaBlind).toBe(1);
    expect(w.staleCount).toBe(1);
  });

  it("surfaces a failure newer than the last success without moving ranAt", () => {
    const lastSync = {
      accountsSeen: 1,
      rowsWritten: 1,
      drift: [],
      errors: [],
      skipped: false,
      skipReason: null,
      startedAt: "2026-11-01T11:00:00.000Z",
      finishedAt: "2026-11-01T11:00:30.000Z",
    } as SyncSummary;
    const failed = buildPageData(
      args({ lastSync, lastFailure: { attemptedAt: NOW, message: "sync failed: boom" } }),
    );
    expect(failed.sync.ranAt).toBe("2026-11-01T11:00:30.000Z");
    expect(failed.sync.lastError).toBe("sync failed: boom");
    expect(failed.sync.lastAttemptAt).toBe(NOW);

    const widget = buildWidgetData(args({ lastSync, lastFailure: { attemptedAt: NOW, message: "boom" } }));
    expect(widget.status).toMatch(/last sync failed/);

    // A failure older than the last success stays recorded but is not shown as current.
    const cleared = buildPageData(
      args({ lastSync, lastFailure: { attemptedAt: "2026-11-01T10:00:00.000Z", message: "old" } }),
    );
    expect(cleared.sync.lastError).toBeNull();
    expect(cleared.sync.lastAttemptAt).toBeNull();
  });
});
