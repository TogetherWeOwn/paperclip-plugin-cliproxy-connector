import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";
import { buildPageData, buildUsageData, buildWidgetData } from "./ui-data.js";
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

  it("surfaces accepted findings as accepted, not as drift", () => {
    const page = buildPageData({
      now: NOW,
      config: testConfig(),
      rows: {},
      lastSync: {
        ...LAST_SYNC,
        drift: [{ kind: "unconfigured-provider", provider: "kimi", detail: "no row for kimi" }],
        acceptedDrift: [
          { kind: "unconfigured-provider", provider: "openrouter", detail: "accepted row" },
        ],
      },
      strike: emptyStrikeBudget(),
    });
    expect(page.drift.map((d) => d.provider)).toEqual(["kimi"]);
    expect(page.accepted.map((d) => d.provider)).toEqual(["openrouter"]);
  });

  it("defaults accepted to empty on summaries written before the ignore config", () => {
    const page = buildPageData({
      now: NOW,
      config: testConfig(),
      rows: {},
      lastSync: LAST_SYNC,
      strike: emptyStrikeBudget(),
    });
    expect(page.accepted).toEqual([]);
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

describe("usage page data", () => {
  function usageRows(): Record<string, AccountUsageRow> {
    return {
      "acct-aaaaaaaaaaaaaaaa": {
        ...row(),
        key: "acct-aaaaaaaaaaaaaaaa",
        quotaBlindReason: null,
        limits: [
          {
            id: "claude:5h",
            label: "Claude unified 5h",
            usedPercent: 80,
            remainingPercent: 20,
            resetsAt: "2026-11-01T13:00:00.000Z",
            limitReached: false,
            allowed: true,
            gating: true,
            observedAt: NOW,
            models: null,
            metrics: ["team plan, resets weekly"],
          },
          {
            id: "claude:7d",
            label: "Claude unified 7d",
            usedPercent: 10,
            remainingPercent: 90,
            resetsAt: null,
            limitReached: false,
            allowed: true,
            gating: true,
            observedAt: NOW,
            models: null,
          },
        ],
      },
      "acct-bbb": {
        ...row(),
        key: "acct-bbb",
        provider: "meta",
        channel: "meta",
        status: "cooling",
        coolingDown: true,
        cooldownUntil: "2026-11-01T12:30:00.000Z",
        limits: [],
        quotaBlind: true,
        quotaBlindReason: "upstream exposes nothing",
      },
    };
  }

  it("reports verdict, headroom, resets, freshness and blind badges per provider", () => {
    const usage = buildUsageData({
      now: NOW,
      config: testConfig(),
      rows: usageRows(),
      lastSync: LAST_SYNC,
    });
    expect(usage.providers.map((p) => p.provider)).toEqual(["claude", "codex"]);
    const claude = usage.providers[0];
    expect(claude).toMatchObject({
      state: "allowed",
      enabledAccounts: 1,
      headroomAccounts: 1,
      blindAccounts: 0,
      blindReason: null,
      // retryAt is set only behind an exhausted verdict; per-account
      // nextReset below still carries the reset.
      retryAt: null,
      retryIn: null,
    });
    expect(claude.freshness).toBe("fresh");
    expect(claude).toMatchObject({
      nextReset: "2026-11-01T13:00:00.000Z",
      nextResetIn: "1h 0m",
    });
    // The page summary shows known resets even though no provider is
    // exhausted (retryAt is null for allowed providers).
    expect(usage.earliestReset).toBe("2026-11-01T13:00:00.000Z");
    expect(usage.earliestResetIn).toBe("1h 0m");
    const [detail] = claude.accounts;
    expect(detail).toMatchObject({
      maskedLabel: "acct-aaaaaaaa…",
      worstRemaining: 20,
      nextReset: "2026-11-01T13:00:00.000Z",
      nextResetIn: "1h 0m",
      quotaBlind: false,
      quotaBlindReason: null,
    });
    expect(detail.limits[0]).toMatchObject({ metrics: ["team plan, resets weekly"] });
    // Meta has no providers[] row: the unconfigured account is not listed.
    expect(allKeys(usage)).toEqual(["acct-aaaaaaaaaaaaaaaa"]);
  });

  it("badges blind accounts with their reason and a cooldown countdown", () => {
    const config = parseConfig({
      cliproxyBaseUrl: "http://127.0.0.1:8317",
      managementKeyHeader: "X-Test-Key",
      managementSecretRef: { uid: "secret-1" },
      providers: [{ provider: "meta", connectionId: "conn-meta", completeInventory: true }],
      audienceConfirmed: true,
    }).config;
    const usage = buildUsageData({ now: NOW, config, rows: usageRows(), lastSync: LAST_SYNC });
    const meta = usage.providers[0];
    // Cooling with a future cooldown end is positively out → exhausted,
    // with retryAt pointing at the cooldown end.
    expect(meta).toMatchObject({
      state: "exhausted",
      enabledAccounts: 1,
      headroomAccounts: 0,
      blindAccounts: 1,
      blindReason: "upstream exposes nothing",
      retryAt: "2026-11-01T12:30:00.000Z",
      retryIn: "30m",
    });
    const [detail] = meta.accounts;
    expect(detail).toMatchObject({
      maskedLabel: "acct-bbb",
      worstRemaining: null,
      nextReset: null,
      cooldownUntil: "2026-11-01T12:30:00.000Z",
      cooldownIn: "30m",
      quotaBlindReason: "upstream exposes nothing",
    });
    expect(detail.key).toBe("acct-bbb"); // full key retained for React keys
    // The exhausted card's retry doubles as the page summary here.
    expect(usage.earliestReset).toBe("2026-11-01T12:30:00.000Z");
  });

  it("excludes disabled rows from the blind badge", () => {
    const config = parseConfig({
      cliproxyBaseUrl: "http://127.0.0.1:8317",
      managementKeyHeader: "X-Test-Key",
      managementSecretRef: { uid: "secret-1" },
      providers: [{ provider: "claude", connectionId: "conn-claude", completeInventory: true }],
      audienceConfirmed: true,
    }).config;
    const healthy = {
      ...usageRows()["acct-aaaaaaaaaaaaaaaa"],
      key: "acct-aaaaaaaaaaaaaaaa",
    } as AccountUsageRow;
    // Disabled rows get no plugin quota and usually read blind; they must
    // not badge a provider whose enabled accounts are healthy.
    const disabledBlind: AccountUsageRow = {
      ...row(),
      key: "acct-cccccccccccccccc",
      provider: "claude",
      channel: "claude",
      status: "disabled",
      limits: [],
      quotaBlind: true,
      quotaBlindReason: "no usable quota windows",
    };
    const usage = buildUsageData({
      now: NOW,
      config,
      rows: { "acct-aaaaaaaaaaaaaaaa": healthy, "acct-cccccccccccccccc": disabledBlind },
      lastSync: LAST_SYNC,
    });
    const claude = usage.providers[0];
    expect(claude).toMatchObject({ blindAccounts: 0, blindReason: null });
    // The disabled row is still listed in the table with its status.
    expect(claude.accounts.map((a) => a.key).sort()).toEqual([
      "acct-aaaaaaaaaaaaaaaa",
      "acct-cccccccccccccccc",
    ]);
  });

  it("derives the blind reason for rows cached before the field existed", () => {
    const legacy = usageRows()["acct-bbb"] as AccountUsageRow;
    const withoutReason: AccountUsageRow = { ...legacy };
    delete withoutReason.quotaBlindReason;
    expect(withoutReason.quotaBlindReason).toBeUndefined();
    const usage = buildUsageData({
      now: NOW,
      config: parseConfig({
        cliproxyBaseUrl: "http://127.0.0.1:8317",
        managementKeyHeader: "X-Test-Key",
        managementSecretRef: { uid: "secret-1" },
        providers: [{ provider: "meta", connectionId: "conn-meta", completeInventory: true }],
        audienceConfirmed: true,
      }).config,
      rows: { "acct-bbb": withoutReason },
      lastSync: LAST_SYNC,
    });
    expect(usage.providers[0]?.blindReason).toBe("panel-only (needs the downloaded auth file)");
  });

  it("ignores spent window resets when selecting the next known reset", () => {
    const config = parseConfig({
      cliproxyBaseUrl: "http://127.0.0.1:8317",
      managementKeyHeader: "X-Test-Key",
      managementSecretRef: { uid: "secret-1" },
      providers: [{ provider: "claude", connectionId: "conn-claude", completeInventory: true }],
      audienceConfirmed: true,
    }).config;
    const stale: AccountUsageRow = {
      ...row(),
      key: "acct-stalestalestale1",
      limits: [
        {
          id: "claude:5h",
          label: "Claude unified 5h",
          usedPercent: 100,
          remainingPercent: 0,
          resetsAt: "2026-11-01T11:00:00.000Z", // spent an hour ago
          limitReached: true,
          allowed: false,
          gating: true,
          observedAt: NOW,
          models: null,
        },
      ],
    };
    const recovering: AccountUsageRow = {
      ...row(),
      key: "acct-recovrecovrecov2",
      limits: [
        {
          id: "claude:7d",
          label: "Claude unified 7d",
          usedPercent: 50,
          remainingPercent: 50,
          resetsAt: "2026-11-01T14:00:00.000Z",
          limitReached: false,
          allowed: true,
          gating: true,
          observedAt: NOW,
          models: null,
        },
      ],
    };
    const usage = buildUsageData({
      now: NOW,
      config,
      rows: { "acct-stalestalestale1": stale, "acct-recovrecovrecov2": recovering },
      lastSync: LAST_SYNC,
    });
    const claude = usage.providers[0];
    // The spent 11:00 reset must not win over the upcoming 14:00 recovery.
    expect(claude).toMatchObject({ nextReset: "2026-11-01T14:00:00.000Z", nextResetIn: "2h 0m" });
    expect(usage).toMatchObject({ earliestReset: "2026-11-01T14:00:00.000Z" });
    const staleDetail = claude.accounts.find((a) => a.key === "acct-stalestalestale1");
    expect(staleDetail?.nextReset).toBeNull();
  });

  function allKeys(usage: ReturnType<typeof buildUsageData>): string[] {
    return usage.providers.flatMap((p) => p.accounts.map((a) => a.key));
  }
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

describe("via provider API provenance", () => {
  it("passes the live-quota flag through to usage page windows", async () => {
    const { buildUsageData } = await import("./ui-data.js");
    const { parseConfig } = await import("./config.js");
    const { config } = parseConfig({
      cliproxyBaseUrl: "http://127.0.0.1:8317",
      managementKeyHeader: "X-Test-Key",
      managementSecretRef: { uid: "s" },
      providers: [{ provider: "meta", connectionId: "conn-meta", completeInventory: false }],
      audienceConfirmed: true,
    });
    const usage = buildUsageData({
      now: NOW,
      config,
      rows: {
        "acct-meta1": {
          key: "acct-meta1",
          provider: "meta",
          channel: "meta",
          status: "active",
          statusMessage: null,
          priority: null,
          limits: [
            {
              id: "meta:window",
              label: "meta window",
              usedPercent: 20,
              remainingPercent: 80,
              resetsAt: null,
              limitReached: false,
              allowed: true,
              gating: true,
              observedAt: NOW,
              models: null,
              metrics: null,
              viaProviderApi: true,
            },
          ],
          planType: "Pro",
          checkedAt: NOW,
          source: "plugin:cliproxy-connector",
          quotaBlind: false,
          quotaBlindReason: null,
          accountHash: null,
          lastError: null,
          coolingDown: false,
          cooldownUntil: null,
        },
      },
      lastSync: null,
    });
    expect(usage.providers[0]?.accounts[0]?.limits[0]?.viaProviderApi).toBe(true);
  });
});
