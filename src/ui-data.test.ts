import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";
import { buildPageData, buildWidgetData } from "./ui-data.js";
import { emptyStrikeBudget } from "./sync.js";
import type { AccountUsageRow } from "./types.js";

const NOW = "2026-11-01T12:00:00.000Z";

function testConfig() {
  const { config, validation } = parseConfig({
    cliproxyBaseUrl: "http://127.0.0.1:8317",
    managementKeyHeader: "X-Test-Key",
    managementSecretRef: { uid: "secret-1" },
    providers: [
      { provider: "claude", connectionId: "conn-claude", completeInventory: true },
      { provider: "codex", connectionId: "conn-codex", completeInventory: false },
    ],
    audienceConfirmed: true,
  });
  expect(validation.ok).toBe(true);
  return config;
}

function row(over: Partial<AccountUsageRow> = {}): AccountUsageRow {
  return {
    key: "acct-aaa",
    provider: "claude",
    channel: "claude",
    status: "active",
    statusMessage: null,
    priority: null,
    limits: [
      {
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
      },
    ],
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

const LAST_SYNC = {
  startedAt: NOW,
  finishedAt: NOW,
  accountsSeen: 1,
  rowsWritten: 1,
  drift: [],
  errors: [],
  skipped: false,
  skipReason: null,
};

describe("page data (per-provider)", () => {
  it("renders one card per providers[] row with aggregate state, connection, and inventory flag", () => {
    const page = buildPageData({
      now: NOW,
      config: testConfig(),
      rows: { "acct-aaa": row() },
      lastSync: LAST_SYNC,
      strike: emptyStrikeBudget(),
    });
    expect(page.providers.map((p) => p.provider)).toEqual(["claude", "codex"]);
    const claude = page.providers[0];
    expect(claude).toMatchObject({
      connectionId: "conn-claude",
      completeInventory: true,
      state: "allowed",
      retryAt: null,
      waitResumeOff: false,
      enabledAccounts: 1,
      headroomAccounts: 1,
    });
    expect(claude.accounts).toHaveLength(1);
    expect(claude.accounts[0]?.key).toBe("acct-aaa");
    // No row: codex aggregates unknown without headroom.
    expect(page.providers[1]).toMatchObject({ state: "unknown", enabledAccounts: 0, waitResumeOff: true });
    expect(page.providers[1]?.reason).toMatch(/wait\/resume is off/i);
  });

  it("surfaces drift from the last sync and earliest retryAt across providers", () => {
    const page = buildPageData({
      now: NOW,
      config: testConfig(),
      rows: {},
      lastSync: {
        ...LAST_SYNC,
        drift: [{ kind: "unconfigured-provider", provider: "kimi", detail: "no row for kimi" }],
      },
      strike: emptyStrikeBudget(),
    });
    expect(page.drift).toHaveLength(1);
    expect(page.drift[0]?.provider).toBe("kimi");
    expect(page.earliestReset).toBeNull();
  });

  it("surfaces proven models, overlaps, and the catalog note", () => {
    const page = buildPageData({
      now: NOW,
      config: testConfig(),
      rows: { "acct-aaa": row() },
      lastSync: {
        ...LAST_SYNC,
        providerModels: { claude: ["claude-opus-4-5"] },
        modelOverlaps: [{ id: "shared-bare-model", providers: ["claude", "codex"] }],
      },
      strike: emptyStrikeBudget(),
    });
    expect(page.providers[0]).toMatchObject({ provider: "claude", models: ["claude-opus-4-5"] });
    expect(page.providers[1]).toMatchObject({ provider: "codex", models: [] });
    expect(page.modelOverlaps).toEqual([{ id: "shared-bare-model", providers: ["claude", "codex"] }]);
    expect(page.modelsNote).toBeNull(); // catalog ran: derivation is on
    const widget = buildWidgetData({
      now: NOW,
      config: testConfig(),
      rows: { "acct-aaa": row() },
      lastSync: {
        ...LAST_SYNC,
        providerModels: { claude: ["claude-opus-4-5"] },
        modelOverlaps: [{ id: "shared-bare-model", providers: ["claude", "codex"] }],
        drift: [{ kind: "model-overlap", provider: "claude", detail: "overlap" }],
      },
      strike: emptyStrikeBudget(),
    });
    expect(widget.modelOverlapCount).toBe(1);
    expect(widget.status).toMatch(/drift finding/); // overlap drift is health-visible
  });

  it("notes when the model catalog is unavailable", () => {
    const page = buildPageData({
      now: NOW,
      config: testConfig(),
      rows: { "acct-aaa": row() },
      lastSync: { ...LAST_SYNC, errors: ["clientApiKeySecretRef is not set: skipping /v1/models"] },
      strike: emptyStrikeBudget(),
    });
    expect(page.providerModels).toEqual({});
    expect(page.modelOverlaps).toEqual([]);
    expect(page.modelsNote).toMatch(/clientApiKeySecretRef/);
  });

  it("shows the audience notice until confirmed", () => {
    const unconfirmed = { ...testConfig(), audienceConfirmed: false };
    const page = buildPageData({
      now: NOW,
      config: unconfirmed,
      rows: {},
      lastSync: null,
      strike: emptyStrikeBudget(),
    });
    expect(page.audienceConfirmed).toBe(false);
    expect(page.audienceNotice).toMatch(/proposal §4 point 4/);
  });
});

describe("widget data", () => {
  it("counts providers by state with drift and wait/resume flags", () => {
    const widget = buildWidgetData({
      now: NOW,
      config: testConfig(),
      rows: { "acct-aaa": row() },
      lastSync: LAST_SYNC,
      strike: emptyStrikeBudget(),
    });
    expect(widget).toMatchObject({
      ok: true,
      providers: 2,
      allowed: 1,
      unknownProviders: 1,
      waitResumeOff: 1,
      driftCount: 0,
    });
    expect(widget.status).toBe("healthy");
  });

  it("reports strike-disabled status", () => {
    const widget = buildWidgetData({
      now: NOW,
      config: testConfig(),
      rows: {},
      lastSync: null,
      strike: { ...emptyStrikeBudget(), disabled: true, disabledReason: "spent" },
    });
    expect(widget.ok).toBe(false);
    expect(widget.status).toMatch(/disabled/);
  });
});
