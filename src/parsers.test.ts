import { describe, expect, it } from "vitest";
import {
  hasAdmissionSignal,
  hashIdentity,
  isGatingWindow,
  normalizeProvider,
  parseAuthFiles,
  parseHeaderSignals,
  parseLegacySignalList,
  parsePluginQuota,
  sanitizeStatusMessage,
} from "./parsers.js";
import { DEFAULT_PROVIDER_WINDOWS } from "./config.js";

const NOW = "2026-11-01T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Redacted auth-files fixture. Shapes mirror the public CLIProxyAPI source
 * (`auth_files.go` entry fields, `quota_signals.go` header-map signals) with
 * every real identifier replaced by fixed redacted stand-ins. No live
 * management output is embedded — if the operator later supplies a redacted
 * live capture, extend this fixture with it.
 */
function redactedAuthFiles() {
  return {
    files: [
      {
        id: "REDACTED-ID-CLAUDE-1",
        auth_index: 1,
        name: "REDACTED-NAME",
        type: "cli",
        provider: "claude",
        label: "REDACTED-LABEL",
        status: "active",
        status_message: "ok",
        disabled: false,
        unavailable: false,
        runtime_only: false,
        source: "file",
        success: 42,
        failed: 0,
        recent_requests: [],
        email: "REDACTED-EMAIL",
        id_token: "REDACTED-TOKEN",
        priority: 5,
        project_id: "REDACTED-PROJECT",
        account_type: "oauth",
        path: "/REDACTED/PATH/auth1.json",
        quota: {
          observed_at: NOW,
          signals: {
            "anthropic-ratelimit-unified-5h-utilization": "0.2",
            "anthropic-ratelimit-unified-5h-reset": iso(NOW_MS + 5 * 3_600_000),
            "anthropic-ratelimit-unified-5h-status": "allowed",
          },
        },
        model_quotas: {
          "claude-sonnet-4-5": {
            observed_at: NOW,
            signals: {
              "anthropic-ratelimit-unified-5h-utilization": "0.9",
              "anthropic-ratelimit-unified-5h-status": "allowed",
            },
          },
        },
      },
      {
        id: "REDACTED-ID-CODEX-1",
        provider: "codex",
        disabled: false,
        unavailable: false,
        priority: 1,
        quota: {
          observed_at: NOW,
          signals: {
            "x-codex-primary-used-percent": "35",
            "x-codex-primary-reset-at": String(Math.floor((NOW_MS + 7 * 24 * 3_600_000) / 1000)),
            "x-codex-primary-allowed": "true",
            "x-codex-plan-type": "plus",
          },
        },
      },
      {
        id: "REDACTED-ID-COOLING-1",
        provider: "claude",
        disabled: false,
        unavailable: true,
        next_retry_after: iso(NOW_MS + 30 * 60_000),
        status_message: "429 rate limited",
      },
      {
        id: "REDACTED-ID-DISABLED-1",
        provider: "meta",
        disabled: true,
      },
    ],
  };
}

describe("provider normalization (parser keys only, never identity)", () => {
  it("maps CLIProxy provider words to parser keys", () => {
    expect(normalizeProvider("claude")).toBe("claude");
    expect(normalizeProvider("Anthropic")).toBe("claude");
    expect(normalizeProvider("codex")).toBe("codex");
    expect(normalizeProvider("openai")).toBe("codex");
    expect(normalizeProvider("meta")).toBe("meta");
    expect(normalizeProvider("gemini")).toBe("antigravity");
    expect(normalizeProvider("nvidia-nim")).toBe("nvidia-nim");
    expect(normalizeProvider("something-new")).toBe("unknown-provider");
  });

  it("does not misfile minimax as nvidia-nim (substring nim is not a token)", () => {
    expect(normalizeProvider("minimax")).toBe("unknown-provider");
  });

  it("only claude/codex/devin/synthetic/cloudflare/zai/opencode-go expose admission signals", () => {
    for (const p of ["claude", "codex", "devin", "synthetic", "cloudflare", "zai", "opencode-go"] as const) {
      expect(hasAdmissionSignal(p)).toBe(true);
    }
    expect(hasAdmissionSignal("meta")).toBe(false);
    expect(hasAdmissionSignal("openrouter")).toBe(false);
    expect(hasAdmissionSignal("unknown-provider")).toBe(false);
  });

  it("gating matches allow-list substrings, case-insensitive", () => {
    expect(isGatingWindow("claude", "5h", ["5H"])).toBe(true);
    // Stock `x-codex-primary-*` windows gate: without this, stock Codex
    // quotas never constrain routing.
    expect(isGatingWindow("codex", "primary", DEFAULT_PROVIDER_WINDOWS.codex)).toBe(true);
    expect(isGatingWindow("codex", "weekly-primary", DEFAULT_PROVIDER_WINDOWS.codex)).toBe(true);
  });
});

describe("parseHeaderSignals (source-mirrored header maps)", () => {
  it("parses the claude unified 5h window: utilization fraction → used%, reset, status", () => {
    const { limits, warnings } = parseHeaderSignals(
      "claude",
      {
        "anthropic-ratelimit-unified-5h-utilization": "0.2",
        "anthropic-ratelimit-unified-5h-reset": iso(NOW_MS + 5 * 3_600_000),
        "anthropic-ratelimit-unified-5h-status": "allowed",
      },
      NOW,
      DEFAULT_PROVIDER_WINDOWS.claude,
    );
    expect(warnings).toEqual([]);
    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({
      id: "claude:5h",
      usedPercent: 20,
      remainingPercent: 80,
      resetsAt: iso(NOW_MS + 5 * 3_600_000),
      limitReached: false,
      allowed: true,
      gating: true,
      observedAt: NOW,
      models: null,
    });
  });

  it("rejected claude status limits even at low utilization", () => {
    const { limits } = parseHeaderSignals(
      "claude",
      {
        "anthropic-ratelimit-unified-5h-utilization": "0.1",
        "anthropic-ratelimit-unified-5h-status": "rejected",
      },
      NOW,
      DEFAULT_PROVIDER_WINDOWS.claude,
    );
    expect(limits[0]).toMatchObject({ allowed: false, limitReached: true });
  });

  it("parses codex namespaced signals with plan type", () => {
    const resetAt = String(Math.floor((NOW_MS + 3_600_000) / 1000));
    const { limits, planType } = parseHeaderSignals(
      "codex",
      {
        "x-codex-5h-primary-used-percent": "35",
        "x-codex-5h-primary-reset-at": resetAt,
        "x-codex-5h-primary-allowed": "true",
        "x-codex-plan-type": "plus",
      },
      NOW,
      ["primary"],
    );
    expect(planType).toBe("plus");
    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({
      id: "codex:5h-primary",
      usedPercent: 35,
      remainingPercent: 65,
      allowed: true,
      gating: true,
    });
    expect(limits[0]?.resetsAt).not.toBeNull();
  });

  it("parses the stock unnamespaced codex primary headers (never silently quota-blind)", () => {
    const { limits } = parseHeaderSignals(
      "codex",
      {
        "x-codex-primary-used-percent": "35",
        "x-codex-primary-reset-at": String(Math.floor((NOW_MS + 3_600_000) / 1000)),
        "x-codex-primary-allowed": "true",
        "x-codex-plan-type": "plus",
      },
      NOW,
      ["primary"],
    );
    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({
      id: "codex:primary",
      usedPercent: 35,
      remainingPercent: 65,
      allowed: true,
      gating: true,
    });
  });

  it("tier windows gate under the default codex allow-list: bare and namespaced agree", () => {
    // Bare `primary` and namespaced `acme-primary` parse to the same gating
    // window under defaults. An explicit stock exhaustion signal
    // (`allowed: false`) is positive evidence and must constrain routing —
    // treating it like a dropped header (unknown, selectable) lets exhausted
    // stock accounts keep receiving traffic. Missing telemetry still reads
    // unknown; only an explicit denial gates.
    const expected = { allowed: false, limitReached: true, gating: true };
    const bare = parseHeaderSignals(
      "codex",
      { "x-codex-primary-allowed": "false" },
      NOW,
      DEFAULT_PROVIDER_WINDOWS.codex,
    );
    expect(bare.limits).toHaveLength(1);
    expect(bare.limits[0]).toMatchObject({ id: "codex:primary", ...expected });
    const namespaced = parseHeaderSignals(
      "codex",
      { "x-codex-acme-primary-allowed": "false" },
      NOW,
      DEFAULT_PROVIDER_WINDOWS.codex,
    );
    expect(namespaced.limits).toHaveLength(1);
    expect(namespaced.limits[0]).toMatchObject({ id: "codex:acme-primary", ...expected });
  });

  it("a bare secondary limit-name labels the secondary window, not primary", () => {
    const { limits } = parseHeaderSignals(
      "codex",
      {
        "x-codex-secondary-used-percent": "35",
        "x-codex-secondary-limit-name": "Plus",
      },
      NOW,
      ["secondary"],
    );
    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({ id: "codex:secondary" });
    expect(limits[0]?.label).toContain("Plus");
  });

  it("a namespaced limit-name labels its own tier window, not a phantom namespace window", () => {
    const { limits } = parseHeaderSignals(
      "codex",
      {
        "x-codex-acme-primary-used-percent": "10",
        "x-codex-acme-primary-limit-name": "Plus",
      },
      NOW,
      ["acme-primary"],
    );
    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({ id: "codex:acme-primary" });
    expect(limits[0]?.label).toContain("Plus");
  });

  it("a limit-name alone emits no window (metadata is never quota evidence)", () => {
    // A bare label for an allow-listed namespace must not fabricate an
    // allowed:null row: for admission-signal providers that reads as
    // limiting and would false-exhaust the account.
    const { limits, warnings } = parseHeaderSignals(
      "codex",
      { "x-codex-weekly-primary-limit-name": "Plus" },
      NOW,
      DEFAULT_PROVIDER_WINDOWS.codex,
    );
    expect(limits).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("a reset timestamp alone emits no window (a bound without a reading is metadata)", () => {
    // A lone reset-at for an allow-listed window would otherwise emit an
    // allowed:null row, which reads as limiting for admission-signal
    // providers and false-exhausts the account until the reset passes.
    const { limits, warnings } = parseHeaderSignals(
      "codex",
      { "x-codex-weekly-primary-reset-at": String(Math.floor((NOW_MS + 3_600_000) / 1000)) },
      NOW,
      DEFAULT_PROVIDER_WINDOWS.codex,
    );
    expect(limits).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("reads codex used-percent on the 0–100 scale (1% is not exhaustion)", () => {
    for (const [raw, used] of [
      ["0", 0],
      ["1", 1],
      ["1.5", 1.5],
      ["35", 35],
    ] as const) {
      const { limits } = parseHeaderSignals(
        "codex",
        { "x-codex-5h-primary-used-percent": raw },
        NOW,
        ["5h-primary"],
      );
      expect(limits).toHaveLength(1);
      expect(limits[0]).toMatchObject({ usedPercent: used, limitReached: false });
    }
  });

  it("a bare retry-after is an explicit 429 watermark for any provider", () => {
    const { limits } = parseHeaderSignals("meta", { "retry-after": "120" }, NOW, []);
    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({
      id: "meta:retry-after",
      remainingPercent: 0,
      limitReached: true,
      allowed: false,
      gating: true,
      resetsAt: iso(NOW_MS + 120_000),
    });
  });

  it("a retry-after cooldown always gates, even under default windows", () => {
    // The default allow-lists carry window substrings ("5h", …), never
    // "retry-after": an explicit 429 watermark must still gate routing.
    const { limits } = parseHeaderSignals(
      "claude",
      { "retry-after": "120" },
      NOW,
      DEFAULT_PROVIDER_WINDOWS.claude,
    );
    expect(limits).toHaveLength(1);
    expect(limits[0]?.gating).toBe(true);
  });

  it("parses stock unnamespaced codex primary/secondary headers", () => {
    const resetAt = String(Math.floor((NOW_MS + 3_600_000) / 1000));
    const { limits, warnings } = parseHeaderSignals(
      "codex",
      {
        "x-codex-primary-used-percent": "100",
        "x-codex-primary-reset-at": resetAt,
        "x-codex-primary-allowed": "false",
      },
      NOW,
      DEFAULT_PROVIDER_WINDOWS.codex,
    );
    expect(warnings).toEqual([]);
    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({
      id: "codex:primary",
      usedPercent: 100,
      remainingPercent: 0,
      allowed: false,
      limitReached: true,
      gating: true,
    });
  });

  it("parses codex used-percent on the 0-100 scale (1% stays 1%)", () => {
    const { limits } = parseHeaderSignals(
      "codex",
      { "x-codex-primary-used-percent": "1" },
      NOW,
      DEFAULT_PROVIDER_WINDOWS.codex,
    );
    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({ id: "codex:primary", usedPercent: 1, remainingPercent: 99 });
  });

  it("treats codex overage above 100% as exhausted, not unknown", () => {
    // 105% used with no explicit denial: dropping the reading would leave no
    // limiting evidence and the account would route as unknown (selectable).
    const { limits } = parseHeaderSignals(
      "codex",
      { "x-codex-primary-used-percent": "105" },
      NOW,
      DEFAULT_PROVIDER_WINDOWS.codex,
    );
    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({
      id: "codex:primary",
      usedPercent: 105,
      remainingPercent: 0,
      allowed: false,
      limitReached: true,
    });
  });

  it("unknown signal keys are ignored with a summary warning, never headroom", () => {
    const { limits, warnings } = parseHeaderSignals("claude", { "x-something-made-up": "1" }, NOW, ["5h"]);
    expect(limits).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("legacy array signals still parse defensively", () => {
    const { limits } = parseLegacySignalList(
      "claude",
      [{ window: "5h", usedPercent: 20, resetAt: iso(NOW_MS + 1000) }],
      NOW,
      ["5h"],
    );
    expect(limits[0]).toMatchObject({ id: "claude:5h", usedPercent: 20, gating: true });
  });
});

describe("parseAuthFiles (redacted fixture)", () => {
  function parse(payload: unknown = redactedAuthFiles(), extra: Record<string, unknown> = {}) {
    return parseAuthFiles(payload, {
      now: NOW,
      allowLists: { claude: ["5h", "7d", "unified"], codex: ["primary", "weekly", "5h"] },
      ...extra,
    });
  }

  it("groups by the raw provider string: openrouter, minimax and cloudflare-workers-ai keep their own groups", () => {
    const { accounts } = parse([
      { id: "o-1", provider: "openrouter" },
      { id: "m-1", provider: "minimax" },
      { id: "cf-1", provider: "cloudflare-workers-ai" },
      { id: "n-1", provider: "nvidia-nim" },
      { id: "c-1", provider: " Claude " },
    ]);
    expect(accounts.map((a) => a.provider)).toEqual([
      "openrouter",
      "minimax",
      "cloudflare-workers-ai",
      "nvidia-nim",
      "claude",
    ]);
    // Quota-blind fallback for the unrecognised providers, real parsers kept.
    expect(accounts.find((a) => a.provider === "openrouter")?.quotaBlind).toBe(true);
    expect(accounts.find((a) => a.provider === "minimax")?.quotaBlind).toBe(true);
    expect(accounts.find((a) => a.provider === "nvidia-nim")?.quotaBlind).toBe(true);
    expect(accounts.find((a) => a.provider === "claude")?.quotaBlind).toBe(true); // no windows → blind
    // The cloudflare-workers-ai row inherits the cloudflare parser's
    // allow-list (raw key first, parser key as fallback).
    const { accounts: cf } = parse([{ id: "cf-1", provider: "cloudflare-workers-ai" }], {
      allowLists: { cloudflare: ["daily"] },
      pluginPayloadByProvider: new Map([
        ["cloudflare-workers-ai", { groups: [{ buckets: [{ window: "daily", remainingFraction: 0.5 }] }] }],
      ]),
    });
    const daily = cf[0]?.limits.find((l) => l.id === "cloudflare:daily");
    expect(daily?.gating).toBe(true);
    expect(cf[0]?.quotaBlind).toBe(false);
  });

  it("coerces a numeric auth_index shape-tolerantly and drops non-index shapes", () => {
    const { accounts } = parse([
      { id: "s-1", provider: "claude", auth_index: "abc123" },
      { id: "n-1", provider: "claude", auth_index: 7 },
      { id: "z-1", provider: "claude", auth_index: 0 },
      { id: "f-1", provider: "claude", auth_index: 1.5 },
      { id: "g-1", provider: "claude", auth_index: -1 },
      { id: "u-1", provider: "claude", auth_index: Number.MAX_SAFE_INTEGER + 1 },
      { id: "b-1", provider: "claude", auth_index: true },
      { id: "e-1", provider: "claude", auth_index: "" },
    ]);
    const indexOf = (id: string) =>
      accounts.find((a) => a.key === `acct-${hashIdentity([id])?.slice(0, 16)}`)?.authIndex;
    expect(indexOf("s-1")).toBe("abc123");
    expect(indexOf("n-1")).toBe("7");
    expect(indexOf("z-1")).toBe("0");
    for (const id of ["f-1", "g-1", "u-1", "b-1", "e-1"]) expect(indexOf(id)).toBeNull();
  });

  it("carries the auth-file name for the served-set fetch", () => {
    const { accounts } = parse([
      { id: "n-1", provider: "claude", name: "claude-file" },
      { id: "n-2", provider: "claude" },
    ]);
    expect(accounts.find((a) => a.key && a.fileName === "claude-file")).toBeDefined();
    expect(accounts.find((a) => a.fileName === null)).toBeDefined();
  });

  it("keys rows acct-<hash>, groups by provider, and never leaks identifiers", () => {
    const { accounts, unkeyed, warnings } = parse();
    expect(unkeyed).toBe(0);
    expect(accounts).toHaveLength(4);
    expect(accounts.map((a) => a.provider)).toEqual(["claude", "codex", "claude", "meta"]);
    for (const a of accounts) {
      expect(a.key).toMatch(/^acct-[0-9a-f]{16}$/);
    }
    const blob = JSON.stringify(accounts);
    for (const secret of ["REDACTED-EMAIL", "REDACTED-TOKEN", "REDACTED-LABEL", "REDACTED-PROJECT", "/REDACTED/PATH"]) {
      expect(blob).not.toContain(secret);
    }
    expect(warnings).toEqual([]);
  });

  it("groups Devin quota by auth-file provider, never by owned_by", () => {
    // Devin serves devin/… ids (including devin/claude-…) while /v1/models
    // reports owned_by: anthropic for them. Quota rows come from auth-files,
    // so the provider is the auth-file word — owned_by never participates.
    const { accounts } = parse([
      {
        id: "REDACTED-ID-DEVIN-1",
        provider: "devin",
        quota: {
          observed_at: NOW,
          signals: {
            "anthropic-ratelimit-unified-5h-utilization": "0.2",
            "anthropic-ratelimit-unified-5h-status": "allowed",
          },
        },
        model_quotas: {
          "claude-opus-4-5": {
            observed_at: NOW,
            signals: { "anthropic-ratelimit-unified-5h-utilization": "0.9" },
          },
        },
      },
    ]);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.provider).toBe("devin");
    // Claude-shaped signals on a Devin account still parse (unknown-provider
    // fallback in parseHeaderSignals covers the claude/provider mismatch).
    expect(accounts[0]?.limits.length).toBeGreaterThan(0);
    const modelWindow = accounts[0]?.limits.find((l) => (l.models ?? []).includes("claude-opus-4-5"));
    expect(modelWindow?.usedPercent).toBe(90);
  });

  it("parses Devin daily/weekly from the auth-files passive signals (live wire shape)", () => {
    // Live shape (CLIProxy v8.0.49 `internal/auth/devin/record.go` →
    // `auth_files.go` quota observation): `quota.signals` carries
    // `daily|weekly_quota_remaining_percent` ("75%") with
    // `daily|weekly_quota_reset_at` (RFC3339) plus `plan`. No Devin plugin
    // quota route serves these — the passive loop is the primary source.
    const { accounts, warnings } = parse(
      [
        {
          id: "REDACTED-ID-DEVIN-2",
          provider: "devin",
          quota: {
            observed_at: NOW,
            signals: {
              daily_quota_remaining_percent: "75%",
              daily_quota_reset_at: iso(NOW_MS + 24 * 3_600_000),
              weekly_quota_remaining_percent: "0%",
              weekly_quota_reset_at: iso(NOW_MS + 7 * 24 * 3_600_000),
              plan: "teams",
            },
          },
        },
      ],
      { allowLists: { devin: ["daily", "weekly"] } },
    );
    expect(accounts).toHaveLength(1);
    const devin = accounts[0]!;
    expect(devin.quotaBlind).toBe(false);
    expect(devin.planType).toBe("teams");
    expect(devin.limits.find((l) => l.id === "devin:daily")).toMatchObject({
      usedPercent: 25,
      remainingPercent: 75,
      resetsAt: iso(NOW_MS + 24 * 3_600_000),
      allowed: true,
      limitReached: false,
      gating: true,
      observedAt: NOW,
    });
    expect(devin.limits.find((l) => l.id === "devin:weekly")).toMatchObject({
      usedPercent: 100,
      remainingPercent: 0,
      allowed: false,
      limitReached: true,
      gating: true,
    });
    expect(warnings).toEqual([]);
  });

  it("reconciles cooling / disabled lifecycle from unavailable + next_retry_after", () => {
    const { accounts } = parse();
    const cooling = accounts.find((a) => a.key !== undefined && a.status === "cooling");
    expect(cooling?.coolingDown).toBe(true);
    expect(cooling?.cooldownUntil).toBe(iso(NOW_MS + 30 * 60_000));
    expect(accounts.find((a) => a.provider === "meta")?.status).toBe("disabled");
  });

  it("keeps a past next_retry_after so a lifted cooldown reads unknown, not out", () => {
    const { accounts } = parse([
      { id: "c-1", provider: "claude", unavailable: true, next_retry_after: iso(NOW_MS - 60_000) },
    ]);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      status: "error",
      coolingDown: true,
      cooldownUntil: iso(NOW_MS - 60_000),
    });
  });

  it("tags model_quotas windows with their model and keeps account-level windows model-free", () => {
    const { accounts } = parse();
    const claude = accounts.find((a) => a.accountHash && a.limits.some((l) => l.models !== null));
    expect(claude).toBeDefined();
    const modelWindow = claude?.limits.find((l) => (l.models ?? []).includes("claude-sonnet-4-5"));
    expect(modelWindow?.usedPercent).toBe(90);
    const accountWindow = claude?.limits.find((l) => l.models === null && l.id === "claude:5h");
    expect(accountWindow?.usedPercent).toBe(20);
  });

  it("attaches per-provider plugin quota with the sync fetch time as observation", () => {
    const body = { subscription: { plan: "pro" }, summary: ["team plan, resets weekly"], groups: [{ buckets: [{ window: "weekly", remainingFraction: 0.8, resetTime: iso(NOW_MS + 7 * 24 * 3_600_000) }] }] };
    const payload = new Map<string, unknown>([["claude", body]]);
    // The fixture's first claude entry carries a numeric auth_index (1), so it
    // attaches only its own file's payload, never the provider-level one.
    const { accounts } = parse(redactedAuthFiles(), {
      pluginPayloadByProvider: payload,
      pluginPayloadByAuthIndex: new Map([["1", body]]),
    });
    const claude = accounts.filter((a) => a.provider === "claude" && a.status !== "disabled");
    expect(claude.length).toBeGreaterThan(0);
    for (const a of claude) {
      const pluginWindow = a.limits.find((l) => l.id === "claude:weekly");
      expect(pluginWindow).toMatchObject({ remainingPercent: 80, observedAt: NOW });
    }
    // Untouched providers get no plugin windows.
    const codex = accounts.find((a) => a.provider === "codex");
    expect(codex?.limits.some((l) => l.id === "codex:weekly")).toBe(false);
  });

  it("meta stays quota-blind; NIM-style providers keep windows non-gating context", () => {
    const { accounts } = parse();
    expect(accounts.find((a) => a.provider === "meta")?.quotaBlind).toBe(true);
  });

  it("accepts every wrapper shape and counts unkeyed entries", () => {
    const entry = { id: "x-1", provider: "claude" };
    for (const payload of [
      [entry],
      { files: [entry] },
      { auth_files: [entry] },
      { authFiles: [entry] },
      { accounts: [entry] },
      { entries: [entry] },
      { data: [entry] },
    ]) {
      const { accounts } = parse(payload);
      expect(accounts).toHaveLength(1);
    }
    const { accounts, unkeyed, warnings } = parse([{ provider: "claude" }]);
    expect(accounts).toHaveLength(0);
    expect(unkeyed).toBe(1);
    expect(warnings.some((w) => w.includes("stable id"))).toBe(true);
  });

  it("drops repeated identities with a warning, keeping the first", () => {
    const { accounts, warnings } = parse([
      { id: "dup-1", provider: "claude" },
      { id: "dup-1", provider: "claude" },
    ]);
    expect(accounts).toHaveLength(1);
    expect(warnings.some((w) => w.includes("duplicate"))).toBe(true);
  });

  it("stays quiet on the always-present empty signals shell without observed_at", () => {
    // CLIProxy sends `quota:{signals:{}}` for every provider, even those
    // with no passive signals: the shell without `observed_at` is expected.
    const { accounts } = parse([{ id: "m-1", provider: "meta", quota: { signals: {} } }]);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.limits).toHaveLength(0);
    expect(accounts[0]?.quotaBlind).toBe(true);
    expect(accounts[0]?.quotaBlindReason).toBe("upstream exposes nothing");
    expect(accounts[0]?.parseWarnings.some((w) => w.includes("no quota signals"))).toBe(false);
  });

  it("still warns when a real observation carries no signals", () => {
    const { accounts } = parse([
      { id: "c-1", provider: "claude", quota: { observed_at: NOW, signals: {} } },
    ]);
    expect(accounts[0]?.parseWarnings.some((w) => w.includes("no quota signals"))).toBe(true);
  });

  it("explains blindness per provider kind", () => {
    const { accounts } = parse([
      { id: "n-1", provider: "nvidia-nim" },
      { id: "c-1", provider: "claude" },
      { id: "m-1", provider: "meta" },
    ]);
    expect(accounts.find((a) => a.provider === "nvidia-nim")).toMatchObject({
      quotaBlind: true,
      quotaBlindReason: "local estimate",
    });
    expect(accounts.find((a) => a.provider === "claude")).toMatchObject({
      quotaBlind: true,
      quotaBlindReason: "no usable quota windows",
    });
    expect(accounts.find((a) => a.provider === "meta")).toMatchObject({
      quotaBlind: true,
      quotaBlindReason: "upstream exposes nothing",
    });
  });

  it("routes openrouter to its own display-only parser key", () => {
    expect(normalizeProvider("openrouter")).toBe("openrouter");
    expect(normalizeProvider("OpenRouter")).toBe("openrouter");
  });

  it("keeps openrouter display-only: blind with non-gating windows", () => {
    const { accounts } = parse([{ id: "o-1", provider: "openrouter" }], {
      allowLists: { openrouter: ["limit"] },
      pluginPayloadByProvider: new Map([
        ["openrouter", { groups: [{ buckets: [{ window: "limit", remainingFraction: 0.9 }] }] }],
      ]),
    });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ quotaBlind: true, quotaBlindReason: "upstream exposes nothing" });
    expect(accounts[0]?.limits).toHaveLength(1);
    expect(accounts[0]?.limits[0]).toMatchObject({ id: "openrouter:limit", gating: false });
  });

  it("collects advertised quota plugin ids for discovery, skipping opt-outs and junk", () => {
    const { accounts, pluginQuotaHints, warnings } = parse([
      { id: "s-1", provider: "synthetic", quota_plugin_id: "synthetic-quota" },
      { id: "s-2", provider: "synthetic", quota_plugin_id: "other-quota" },
      { id: "x-1", provider: "xai", quota_plugin_id: "../evil" },
      { id: "d-1", provider: "devin", quota_plugin_id: "devin-quota", supports_quota: false },
      { id: "m-1", provider: "meta", disabled: true, quota_plugin_id: "meta-quota" },
    ]);
    expect(pluginQuotaHints.get("synthetic")).toBe("synthetic-quota");
    expect(pluginQuotaHints.get("xai")).toBeUndefined();
    expect(pluginQuotaHints.get("devin")).toBeUndefined();
    expect(pluginQuotaHints.get("meta")).toBeUndefined(); // disabled entries never contribute
    expect(warnings.some((w) => w.includes("conflicting quota plugin ids"))).toBe(true);
    expect(warnings.some((w) => w.includes("unusable advertised quota plugin id"))).toBe(true);
    // Same-provider accounts on different plugins keep their own route, so
    // the sync can fetch each credential against the plugin that serves it.
    expect(accounts.find((a) => a.quotaPluginId === "synthetic-quota")).toBeDefined();
    expect(accounts.find((a) => a.quotaPluginId === "other-quota")).toBeDefined();
    expect(accounts.find((a) => a.provider === "devin")?.quotaPluginId).toBeNull();
  });
});

describe("parsePluginQuota (lowercase wire shape)", () => {
  it("maps remainingFraction to used% with resetTime and plan", () => {
    const { limits, planType } = parsePluginQuota(
      "synthetic",
      {
        subscription: { plan: "team" },
        groups: [{ buckets: [{ window: "weekly", remainingFraction: 0.8, resetTime: iso(NOW_MS + 1000) }] }],
      },
      ["weekly"],
    );
    expect(planType).toBe("team");
    expect(limits[0]).toMatchObject({
      usedPercent: 20,
      remainingPercent: 80,
      allowed: true,
      gating: true,
      observedAt: null,
    });
  });

  it("parses the lowercase wire shape with zero warnings (no silent blindness)", () => {
    // The exact CLIProxyAPI `pluginapi` JSON tags: lowercase `groups`,
    // `buckets`, `window`, `remainingFraction`, `resetTime`. On 0.2.2 this
    // payload parsed to zero windows (PascalCase-only `Buckets` read) with
    // no warning, leaving Synthetic/Cloudflare/NIM quota-blind.
    const { limits, warnings } = parsePluginQuota(
      "synthetic",
      {
        subscription: { plan: "team" },
        groups: [{ buckets: [{ window: "rolling-5h", remainingFraction: 0.6, resetTime: iso(NOW_MS + 1000) }] }],
      },
      ["rolling-5h"],
      { observedAt: NOW },
    );
    expect(warnings).toEqual([]);
    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({
      id: "synthetic:rolling-5h",
      remainingPercent: 60,
      allowed: true,
      gating: true,
      observedAt: NOW,
    });
  });

  it("warns when a group carries no buckets instead of going silently blind", () => {
    const { limits, warnings } = parsePluginQuota(
      "synthetic",
      { groups: [{ window: "weekly" }] },
      ["weekly"],
    );
    expect(limits).toHaveLength(0);
    expect(warnings.some((w) => w.includes("no buckets"))).toBe(true);
  });

  it("warns on a group with an empty buckets array", () => {
    const { limits, warnings } = parsePluginQuota("synthetic", { groups: [{ buckets: [] }] }, ["weekly"]);
    expect(limits).toHaveLength(0);
    expect(warnings.some((w) => w.includes("no buckets"))).toBe(true);
  });

  it("still accepts the PascalCase aliases shape-tolerantly", () => {
    const { limits, warnings } = parsePluginQuota(
      "synthetic",
      {
        Subscription: { Plan: "team" },
        Groups: [{ Buckets: [{ Window: "weekly", RemainingFraction: 0.8, ResetTime: iso(NOW_MS + 1000) }] }],
      },
      ["weekly"],
    );
    expect(warnings).toEqual([]);
    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({ remainingPercent: 80 });
  });

  it("zero remaining exhausts with allowed=false", () => {
    const { limits } = parsePluginQuota(
      "synthetic",
      { groups: [{ buckets: [{ window: "weekly", remainingFraction: 0 }] }] },
      ["weekly"],
      { observedAt: NOW },
    );
    expect(limits[0]).toMatchObject({ allowed: false, limitReached: true, observedAt: NOW });
  });

  it("non-object payloads become quota-blind warnings, never headroom", () => {
    const { limits, warnings } = parsePluginQuota("synthetic", "nope", ["weekly"]);
    expect(limits).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("carries summary[] as a display-only per-row metrics array", () => {
    const { limits } = parsePluginQuota(
      "synthetic",
      {
        subscription: { plan: "team" },
        summary: ["team plan, resets weekly"],
        groups: [
          {
            buckets: [
              {
                window: "weekly",
                remainingFraction: 0.8,
                summary: ["burst allowance included"],
              },
            ],
          },
        ],
      },
      ["weekly"],
    );
    expect(limits).toHaveLength(1);
    expect(limits[0]?.metrics).toEqual(["team plan, resets weekly", "burst allowance included"]);
    expect(limits[0]?.gating).toBe(true);
  });

  it("scrubs account identifiers from summary[] before surfacing metrics", () => {
    const { limits } = parsePluginQuota(
      "synthetic",
      {
        summary: ["team plan, resets weekly", "owner ops@example.com", "refresh ab12cd34ef"],
        groups: [{ buckets: [{ window: "weekly", remainingFraction: 0.8 }] }],
      },
      ["weekly"],
    );
    expect(limits[0]?.metrics).toEqual([
      "team plan, resets weekly",
      "owner [redacted-email]",
      "refresh [redacted]",
    ]);
  });

  it("parses Devin daily/weekly remaining-percent fields, stripping %", () => {
    const { limits, warnings } = parsePluginQuota(
      "devin",
      {
        daily_quota_remaining_percent: "75%",
        daily_reset_at: iso(NOW_MS + 24 * 3_600_000),
        weekly_quota_remaining_percent: "50",
        weekly_reset_at: iso(NOW_MS + 7 * 24 * 3_600_000),
      },
      ["daily", "weekly"],
      { observedAt: NOW },
    );
    expect(warnings).toEqual([]);
    expect(limits).toHaveLength(2);
    expect(limits.find((l) => l.id === "devin:daily")).toMatchObject({
      usedPercent: 25,
      remainingPercent: 75,
      resetsAt: iso(NOW_MS + 24 * 3_600_000),
      allowed: true,
      gating: true,
      observedAt: NOW,
    });
    expect(limits.find((l) => l.id === "devin:weekly")).toMatchObject({
      usedPercent: 50,
      remainingPercent: 50,
      allowed: true,
      gating: true,
    });
  });

  it("exhausts a zero-percent Devin window and skips unusable percents with a warning", () => {
    const { limits, warnings } = parsePluginQuota(
      "devin",
      {
        daily_quota_remaining_percent: "0%",
        weekly_quota_remaining_percent: "plenty",
      },
      ["daily", "weekly"],
    );
    expect(limits.find((l) => l.id === "devin:daily")).toMatchObject({
      remainingPercent: 0,
      allowed: false,
      limitReached: true,
    });
    expect(limits.some((l) => l.id === "devin:weekly")).toBe(false);
    expect(warnings.some((w) => w.includes("weekly quota percent"))).toBe(true);
  });
});

describe("sanitizeStatusMessage", () => {
  it("keeps short operational notes unchanged", () => {
    expect(sanitizeStatusMessage("ok")).toBe("ok");
    expect(sanitizeStatusMessage("429 rate limited")).toBe("429 rate limited");
    expect(sanitizeStatusMessage(null)).toBeNull();
  });

  it("redacts emails and long tokens instead of leaking them to the page", () => {
    const scrubbed = sanitizeStatusMessage("quota exceeded for user@example.com, token abcdefghijklmnopqrstu") ?? "";
    expect(scrubbed).not.toContain("user@example.com");
    expect(scrubbed).not.toContain("abcdefghijklmnopqrstu");
    expect(scrubbed).toContain("[redacted-email]");
    expect(scrubbed).toContain("[redacted]");
  });

  it("redacts short credential-like tokens but keeps hyphenated operational words", () => {
    const scrubbed = sanitizeStatusMessage("auth failed, key ab12cd34ef, retry rate-limited soon") ?? "";
    expect(scrubbed).not.toContain("ab12cd34ef");
    expect(scrubbed).toContain("[redacted]");
    expect(scrubbed).toContain("rate-limited");
  });

  it("keeps timestamps, versions, k=v pairs and model ids out of the redactor", () => {
    const msg = "reset 2026-11-01T12:00:00Z via HTTP/1.1, error=429 for gpt-4o-mini, key sk-live-abc123";
    const scrubbed = sanitizeStatusMessage(msg) ?? "";
    for (const keep of ["2026-11-01T12:00:00Z", "HTTP/1.1", "error=429", "gpt-4o-mini"]) {
      expect(scrubbed).toContain(keep);
    }
    expect(scrubbed).not.toContain("sk-live-abc123");
    expect(scrubbed).toContain("[redacted]");
  });

  it("redacts credential-shaped k=v values and interleaved-alphanumeric slugs", () => {
    const scrubbed = sanitizeStatusMessage("retry token=ab12cd34ef with sk-live-a1b2c3d4 for llama-3-3-70b") ?? "";
    expect(scrubbed).not.toContain("token=ab12cd34ef");
    expect(scrubbed).not.toContain("sk-live-a1b2c3d4");
    expect(scrubbed).toContain("llama-3-3-70b");
    expect(scrubbed).toContain("[redacted]");
  });

  it("redacts internal-digit slugs and label:credential tokens, keeps timestamps", () => {
    const scrubbed =
      sanitizeStatusMessage("key sk-live-abc123def, token:ab12cd34ef seen 2026-11-01T12:00:00Z") ?? "";
    expect(scrubbed).not.toContain("sk-live-abc123def");
    expect(scrubbed).not.toContain("token:ab12cd34ef");
    expect(scrubbed).toContain("2026-11-01T12:00:00Z");
    expect(scrubbed).toContain("[redacted]");
  });

  it("redacts segmented letter-digit credentials spread across hyphen parts", () => {
    const scrubbed = sanitizeStatusMessage("key sk-live-a1-b2-c3-d4 rejected") ?? "";
    expect(scrubbed).not.toContain("sk-live-a1-b2-c3-d4");
    expect(scrubbed).toContain("[redacted]");
  });

  it("keeps multi-version model ids while redacting segmented credentials", () => {
    const scrubbed =
      sanitizeStatusMessage("model gpt-4o-mini-v2 unavailable, key sk-live-a1-b2-c3-d4 rejected") ?? "";
    expect(scrubbed).toContain("gpt-4o-mini-v2");
    expect(scrubbed).not.toContain("sk-live-a1-b2-c3-d4");
    expect(scrubbed).toContain("[redacted]");
  });

  it("keeps dotted hostnames and versions but redacts dotted credentials", () => {
    const scrubbed =
      sanitizeStatusMessage("lookup s3.amazonaws.com failed, deploy v1.2.3-beta1 ready, note sk.live.a1.b2 here") ??
      "";
    expect(scrubbed).toContain("s3.amazonaws.com");
    expect(scrubbed).toContain("v1.2.3-beta1");
    expect(scrubbed).not.toContain("sk.live.a1.b2");
    expect(scrubbed).toContain("[redacted]");
  });

  it("redacts date-shaped credentials while keeping bare timestamps", () => {
    const scrubbed = sanitizeStatusMessage("key sk-2026-11-01-ab12 seen 2026-11-01T12:00Z") ?? "";
    expect(scrubbed).not.toContain("sk-2026-11-01-ab12");
    expect(scrubbed).toContain("2026-11-01T12:00Z");
    expect(scrubbed).toContain("[redacted]");
  });

  it("keeps dotted model ids and minute-precision timestamps out of the redactor", () => {
    const scrubbed =
      sanitizeStatusMessage("reset 2026-11-01T12:00Z for claude-3.5-sonnet, gemini-2.5-flash-lite, llama-3.1-70b-instruct") ?? "";
    for (const keep of [
      "2026-11-01T12:00Z",
      "claude-3.5-sonnet",
      "gemini-2.5-flash-lite",
      "llama-3.1-70b-instruct",
    ]) {
      expect(scrubbed).toContain(keep);
    }
    expect(scrubbed).not.toContain("[redacted]");
  });

  it("keeps fractional-second and offset timestamps out of the redactor", () => {
    const scrubbed =
      sanitizeStatusMessage("retry 2026-11-01T12:00:00.000Z, backoff 2026-11-01T12:00:00+00:00") ?? "";
    expect(scrubbed).toContain("2026-11-01T12:00:00.000Z");
    expect(scrubbed).toContain("2026-11-01T12:00:00+00:00");
    expect(scrubbed).not.toContain("[redacted]");
  });

  it("redacts dotted credentials that hide behind an operational-looking label", () => {
    const scrubbed = sanitizeStatusMessage("note sk.production.a1.b2 here") ?? "";
    expect(scrubbed).not.toContain("sk.production.a1.b2");
    expect(scrubbed).toContain("[redacted]");
  });

  it("keeps dotted versions and hostnames with several structured mixed labels", () => {
    const scrubbed =
      sanitizeStatusMessage("deploy v1.2.3rc1 on s3.us2.amazonaws.com, note sk.production.a1.b2 here") ?? "";
    expect(scrubbed).toContain("v1.2.3rc1");
    expect(scrubbed).toContain("s3.us2.amazonaws.com");
    expect(scrubbed).not.toContain("sk.production.a1.b2");
    expect(scrubbed).toContain("[redacted]");
  });

  it("redacts segmented credentials that end on a payload word", () => {
    const scrubbed =
      sanitizeStatusMessage("deploy v1.2.3rc1 on s3.us2.amazonaws.com, note a1.b2.production here") ?? "";
    expect(scrubbed).not.toContain("a1.b2.production");
    expect(scrubbed).toContain("[redacted]");
    expect(scrubbed).toContain("v1.2.3rc1");
    expect(scrubbed).toContain("s3.us2.amazonaws.com");
  });
});

describe("hashIdentity redaction", () => {
  it("is deterministic, opaque, and never embeds input", () => {
    const a = hashIdentity(["id-1", "label"]);
    expect(a).toBe(hashIdentity(["id-1", "label"]));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain("id-1");
  });
});

describe("parseMetaQuota (panel metaQuota.ts shape)", () => {
  const metaWindows = () => DEFAULT_PROVIDER_WINDOWS.meta as string[];
  const body = () => ({
    subs_usage: {
      tier: "Pro",
      window: { used_percent: 25, resets_at: Math.floor(NOW_MS / 1000) + 3600, window_duration_mins: 60 },
      weekly: { used_percent: 10, resets_at: Math.floor(NOW_MS / 1000) + 86400 },
    },
    subs_tier_name: "Pro",
    is_subs_active: true,
  });

  it("emits window + weekly windows with remaining % and resets, labelled via provider API", async () => {
    const { parseMetaQuota } = await import("./parsers.js");
    const parsed = parseMetaQuota(body(), NOW, metaWindows());
    expect(parsed.warnings).toEqual([]);
    expect(parsed.planType).toBe("Pro");
    expect(parsed.limits.map((l) => l.id)).toEqual(["meta:window", "meta:weekly"]);
    expect(parsed.limits[0]?.remainingPercent).toBe(75);
    expect(parsed.limits[0]?.usedPercent).toBe(25);
    expect(parsed.limits[0]?.resetsAt).toBe(iso(NOW_MS + 3600_000));
    expect(parsed.limits[1]?.remainingPercent).toBe(90);
    for (const l of parsed.limits) {
      expect(l.viaProviderApi).toBe(true);
      expect(l.gating).toBe(true);
      expect(l.allowed).toBe(true);
      expect(l.observedAt).toBe(NOW);
    }
  });

  it("marks an expected-but-unusable window unknown instead of implying coverage", async () => {
    const { parseMetaQuota } = await import("./parsers.js");
    const payload = body();
    (payload.subs_usage as Record<string, unknown>).weekly = { used_percent: "not-a-number" };
    const parsed = parseMetaQuota(payload, NOW, metaWindows());
    expect(parsed.limits.map((l) => l.id)).toEqual(["meta:window", "meta:weekly"]);
    expect(parsed.limits[1]?.remainingPercent).toBeNull();
    expect(parsed.limits[1]?.allowed).toBeNull();
    expect(parsed.limits[1]?.gating).toBe(true);
    expect(parsed.limits[1]?.viaProviderApi).toBe(true);
    expect(parsed.warnings.join(" ")).toMatch(/weekly.*unknown/);
  });

  it("forces exhausted windows when the subscription is inactive", async () => {
    const { parseMetaQuota } = await import("./parsers.js");
    const parsed = parseMetaQuota({ ...body(), is_subs_active: false }, NOW, metaWindows());
    expect(parsed.limits.length).toBe(2);
    for (const l of parsed.limits) {
      expect(l.limitReached).toBe(true);
      expect(l.allowed).toBe(false);
    }
    expect(parsed.warnings.join(" ")).toMatch(/inactive/);
  });

  it("returns plan-only with zero windows when subs_usage is absent (unknown, not zero)", async () => {
    const { parseMetaQuota } = await import("./parsers.js");
    const parsed = parseMetaQuota({ subs_tier_name: "Pro", is_subs_active: true }, NOW, metaWindows());
    expect(parsed.planType).toBe("Pro");
    expect(parsed.limits).toEqual([]);
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });

  it("warns with zero windows on a non-object answer", async () => {
    const { parseMetaQuota } = await import("./parsers.js");
    for (const bad of [null, 42, "not-json{{{"]) {
      const parsed = parseMetaQuota(bad, NOW, metaWindows());
      expect(parsed.limits).toEqual([]);
      expect(parsed.warnings.length).toBeGreaterThan(0);
    }
  });
});

describe("parseAntigravitySubscription (panel antigravitySubscription.ts shape)", () => {
  const antigravityWindows = () => DEFAULT_PROVIDER_WINDOWS.antigravity as string[];

  it("resolves the paid tier over the current tier through PLAN_BY_TIER_ID", async () => {
    const { parseAntigravitySubscription } = await import("./parsers.js");
    const parsed = parseAntigravitySubscription(
      { currentTier: { id: "free-tier", name: "Free" }, paidTier: { id: "g1-pro-tier", name: "Pro" } },
      NOW,
      antigravityWindows(),
    );
    expect(parsed.planType).toBe("Pro");
    // Subscription alone carries no quota windows: plan only, still blind.
    expect(parsed.limits).toEqual([]);
  });

  it("parses opportunistic quota-summary groups into windows", async () => {
    const { parseAntigravitySubscription } = await import("./parsers.js");
    const parsed = parseAntigravitySubscription(
      {
        currentTier: { id: "g1-ultra-tier", name: "Ultra" },
        groups: [
          {
            buckets: [
              { window: "weekly", remainingFraction: 0.4, resetTime: "2026-11-08T12:00:00.000Z", description: "Ultra weekly" },
            ],
          },
        ],
      },
      NOW,
      antigravityWindows(),
    );
    expect(parsed.planType).toBe("Ultra");
    expect(parsed.limits.length).toBe(1);
    expect(parsed.limits[0]?.remainingPercent).toBe(40);
    expect(parsed.limits[0]?.gating).toBe(true);
    expect(parsed.limits[0]?.viaProviderApi).toBe(true);
  });

  it("reads percent strings at percent scale, not fraction scale", async () => {
    const { parseAntigravitySubscription } = await import("./parsers.js");
    const parsed = parseAntigravitySubscription(
      {
        currentTier: { id: "g1-pro-tier", name: "Pro" },
        groups: [
          {
            buckets: [
              { window: "5h", remainingFraction: "42%" },
              { window: "weekly", remainingFraction: "1%" },
              { window: "daily", remainingFraction: "0.5%" },
            ],
          },
        ],
      },
      NOW,
      antigravityWindows(),
    );
    expect(parsed.limits.map((l) => l.remainingPercent)).toEqual([42, 1, 0.5]);
    expect(parsed.limits.map((l) => l.usedPercent)).toEqual([58, 99, 99.5]);
  });

  it("disambiguates repeated bucket windows instead of emitting duplicate ids", async () => {
    const { parseAntigravitySubscription } = await import("./parsers.js");
    const parsed = parseAntigravitySubscription(
      {
        currentTier: { id: "g1-pro-tier", name: "Pro" },
        groups: [
          { buckets: [{ window: "weekly", remainingFraction: 0.4 }] },
          { buckets: [{ window: "weekly", remainingFraction: 0.25 }] },
        ],
      },
      NOW,
      antigravityWindows(),
    );
    expect(parsed.limits.map((l) => l.id)).toEqual([
      "antigravity:weekly",
      "antigravity:weekly#2",
    ]);
    expect(parsed.limits.map((l) => l.remainingPercent)).toEqual([40, 25]);
  });

  it("warns with zero windows when no tier is named", async () => {
    const { parseAntigravitySubscription } = await import("./parsers.js");
    const parsed = parseAntigravitySubscription({ currentTier: {}, paidTier: {} }, NOW, antigravityWindows());
    expect(parsed.limits).toEqual([]);
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });
});

describe("parseDevinQuota (panel devinQuota.ts shape)", () => {
  const devinWindows = () => DEFAULT_PROVIDER_WINDOWS.devin as string[];
  const resetUnix = Math.floor(NOW_MS / 1000) + 7200;
  const body = () => ({
    userStatus: {
      planStatus: {
        dailyQuotaRemainingPercent: 75,
        dailyQuotaResetAtUnix: resetUnix,
        weeklyQuotaRemainingPercent: "50",
        weeklyQuotaResetAtUnix: String(resetUnix),
        planInfo: { planName: "Devin Pro" },
      },
    },
  });

  it("emits daily + weekly windows from the live RPC with resets and plan", async () => {
    const { parseDevinQuota } = await import("./parsers.js");
    const parsed = parseDevinQuota(body(), NOW, devinWindows());
    expect(parsed.warnings).toEqual([]);
    expect(parsed.planType).toBe("Devin Pro");
    expect(parsed.limits.map((l) => l.id)).toEqual(["devin:daily", "devin:weekly"]);
    expect(parsed.limits[0]?.remainingPercent).toBe(75);
    expect(parsed.limits[0]?.usedPercent).toBe(25);
    expect(parsed.limits[0]?.resetsAt).toBe(iso(resetUnix * 1000));
    expect(parsed.limits[1]?.remainingPercent).toBe(50);
    for (const l of parsed.limits) {
      expect(l.viaProviderApi).toBe(true);
      expect(l.gating).toBe(true);
      expect(l.allowed).toBe(true);
    }
  });

  it("rejects non-strict percents the way the panel does (trailing % is signals-only)", async () => {
    const { parseDevinQuota } = await import("./parsers.js");
    const payload = body();
    (payload.userStatus.planStatus as Record<string, unknown>).dailyQuotaRemainingPercent = "75%";
    const parsed = parseDevinQuota(payload, NOW, devinWindows());
    expect(parsed.limits.map((l) => l.id)).toEqual(["devin:daily", "devin:weekly"]);
    expect(parsed.limits[0]?.remainingPercent).toBeNull();
    expect(parsed.limits[0]?.allowed).toBeNull();
    expect(parsed.limits[0]?.gating).toBe(true);
    expect(parsed.warnings.join(" ")).toMatch(/daily.*unknown/);
  });

  it("warns and emits expected unknown windows when the RPC carries no usable quota", async () => {
    const { parseDevinQuota } = await import("./parsers.js");
    const parsed = parseDevinQuota({ userStatus: { planStatus: { planInfo: {} } } }, NOW, devinWindows());
    expect(parsed.limits.map((l) => l.id)).toEqual(["devin:daily", "devin:weekly"]);
    for (const limit of parsed.limits) {
      expect(limit.remainingPercent).toBeNull();
      expect(limit.allowed).toBeNull();
      expect(limit.gating).toBe(true);
    }
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });
});

describe("parseAuthFiles with live provider-API payloads", () => {
  const filesFor = (provider: string, authIndex: string) => ({
    files: [
      {
        id: `REDACTED-ID-${provider}`,
        auth_index: authIndex,
        name: "REDACTED-NAME",
        type: "cli",
        provider,
        disabled: false,
        unavailable: false,
      },
    ],
  });
  const allowLists = () => ({ ...DEFAULT_PROVIDER_WINDOWS });

  it("attaches meta windows to their own account and clears quota-blind", async () => {
    const { parseAuthFiles } = await import("./parsers.js");
    const resetUnix = Math.floor(NOW_MS / 1000) + 3600;
    const { accounts } = parseAuthFiles(filesFor("meta", "m1"), {
      now: NOW,
      allowLists: allowLists(),
      apiCallPayloadByAuthIndex: new Map([
        [
          "m1",
          {
            statusCode: 200,
            body: {
              subs_usage: {
                window: { used_percent: 20, resets_at: resetUnix },
                weekly: { used_percent: 5, resets_at: resetUnix + 86400 },
              },
              subs_tier_name: "Pro",
              is_subs_active: true,
            },
          },
        ],
      ]),
      apiCallObservedAt: NOW,
    });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.quotaBlind).toBe(false);
    expect(accounts[0]?.planType).toBe("Pro");
    expect(accounts[0]?.limits.map((l) => l.id)).toEqual(["meta:window", "meta:weekly"]);
    expect(accounts[0]?.limits.every((l) => l.viaProviderApi === true)).toBe(true);
  });

  it("a partial meta answer keeps the expected unknown window without quota-blindness", async () => {
    const { parseAuthFiles } = await import("./parsers.js");
    const { accounts } = parseAuthFiles(filesFor("meta", "m3"), {
      now: NOW,
      allowLists: allowLists(),
      apiCallPayloadByAuthIndex: new Map([
        [
          "m3",
          {
            statusCode: 200,
            body: {
              subs_usage: {
                window: { used_percent: 20, resets_at: NOW_MS / 1000 + 3600 },
                weekly: { used_percent: "not-a-number" },
              },
              subs_tier_name: "Pro",
              is_subs_active: true,
            },
          },
        ],
      ]),
      apiCallObservedAt: NOW,
    });
    expect(accounts[0]?.quotaBlind).toBe(false);
    expect(accounts[0]?.limits.map((l) => l.id)).toEqual(["meta:window", "meta:weekly"]);
    expect(accounts[0]?.limits[1]?.allowed).toBeNull();
  });

  it("an upstream 429 warns per file and stays quota-blind (fail open)", async () => {
    const { parseAuthFiles } = await import("./parsers.js");
    const { accounts } = parseAuthFiles(filesFor("devin", "d9"), {
      now: NOW,
      allowLists: allowLists(),
      apiCallPayloadByAuthIndex: new Map([["d9", { statusCode: 429, body: { error: "slow down" } }]]),
      apiCallObservedAt: NOW,
    });
    expect(accounts[0]?.quotaBlind).toBe(true);
    expect(accounts[0]?.limits).toEqual([]);
    expect(accounts[0]?.parseWarnings.join(" ")).toMatch(/429/);
  });

  it("meta without a live answer stays quota-blind with the upstream reason", async () => {
    const { parseAuthFiles } = await import("./parsers.js");
    const { accounts } = parseAuthFiles(filesFor("meta", "m2"), {
      now: NOW,
      allowLists: allowLists(),
    });
    expect(accounts[0]?.quotaBlind).toBe(true);
    expect(accounts[0]?.quotaBlindReason).toBe("upstream exposes nothing");
  });
});

describe("live windows supersede same-id passive windows", () => {
  it("keeps one fresh live window instead of a stale passive twin", async () => {
    const { parseAuthFiles } = await import("./parsers.js");
    const resetUnix = Math.floor(NOW_MS / 1000) + 7200;
    const { accounts } = parseAuthFiles(
      {
        files: [
          {
            id: "REDACTED-ID-DEVIN",
            auth_index: "d1",
            name: "REDACTED-NAME",
            provider: "devin",
            disabled: false,
            unavailable: false,
            quota: {
              observed_at: "2026-10-01T12:00:00.000Z",
              signals: {
                "daily-quota-remaining-percent": "10%",
                "daily-quota-reset-at": "2026-10-01T13:00:00.000Z",
                "weekly-quota-remaining-percent": "20%",
                "weekly-quota-reset-at": "2026-10-08T12:00:00.000Z",
                plan: "Devin",
              },
            },
          },
        ],
      },
      {
        now: NOW,
        allowLists: { ...DEFAULT_PROVIDER_WINDOWS },
        apiCallPayloadByAuthIndex: new Map([
          [
            "d1",
            {
              statusCode: 200,
              body: {
                userStatus: {
                  planStatus: {
                    dailyQuotaRemainingPercent: 60,
                    dailyQuotaResetAtUnix: resetUnix,
                    weeklyQuotaRemainingPercent: 80,
                    weeklyQuotaResetAtUnix: resetUnix + 86400,
                    planInfo: { planName: "Devin Pro" },
                  },
                },
              },
            },
          ],
        ]),
        apiCallObservedAt: NOW,
      },
    );
    expect(accounts).toHaveLength(1);
    const ids = accounts[0]?.limits.map((l) => l.id) ?? [];
    expect(ids).toEqual(["devin:daily", "devin:weekly"]);
    expect(accounts[0]?.limits[0]?.remainingPercent).toBe(60);
    expect(accounts[0]?.limits[0]?.observedAt).toBe(NOW);
    expect(accounts[0]?.limits.every((l) => l.viaProviderApi === true)).toBe(true);
    expect(accounts[0]?.quotaBlind).toBe(false);
  });
});
