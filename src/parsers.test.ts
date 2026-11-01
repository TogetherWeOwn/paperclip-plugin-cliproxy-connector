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

describe("provider normalization", () => {
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

  it("only claude/codex/devin/synthetic/cloudflare/zai/opencode-go expose admission signals", () => {
    for (const p of ["claude", "codex", "devin", "synthetic", "cloudflare", "zai", "opencode-go"] as const) {
      expect(hasAdmissionSignal(p)).toBe(true);
    }
    expect(hasAdmissionSignal("meta")).toBe(false);
    expect(hasAdmissionSignal("unknown-provider")).toBe(false);
  });

  it("gating matches allow-list substrings, case-insensitive", () => {
    expect(isGatingWindow("claude", "5h", ["5H"])).toBe(true);
    expect(isGatingWindow("codex", "primary", DEFAULT_PROVIDER_WINDOWS.codex)).toBe(false);
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

  it("a bare retry-after is an explicit 429 watermark for any provider", () => {
    const { limits } = parseHeaderSignals("meta", { "retry-after": "120" }, NOW, []);
    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({
      id: "meta:retry-after",
      remainingPercent: 0,
      limitReached: true,
      allowed: false,
      resetsAt: iso(NOW_MS + 120_000),
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

  it("reconciles cooling / disabled lifecycle from unavailable + next_retry_after", () => {
    const { accounts } = parse();
    const cooling = accounts.find((a) => a.key !== undefined && a.status === "cooling");
    expect(cooling?.coolingDown).toBe(true);
    expect(cooling?.cooldownUntil).toBe(iso(NOW_MS + 30 * 60_000));
    expect(accounts.find((a) => a.provider === "meta")?.status).toBe("disabled");
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
    const payload = new Map<string, unknown>([
      ["claude", { Subscription: { Plan: "pro" }, Groups: [{ Buckets: [{ Window: "weekly", RemainingFraction: 0.8, ResetTime: iso(NOW_MS + 7 * 24 * 3_600_000) }] }] }],
    ]);
    const { accounts } = parse(redactedAuthFiles(), { pluginPayloadByProvider: payload });
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
});

describe("parsePluginQuota", () => {
  it("maps RemainingFraction to used% with ResetTime and plan", () => {
    const { limits, planType } = parsePluginQuota(
      "synthetic",
      {
        Subscription: { Plan: "team" },
        Groups: [{ Buckets: [{ Window: "weekly", RemainingFraction: 0.8, ResetTime: iso(NOW_MS + 1000) }] }],
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

  it("zero remaining exhausts with allowed=false", () => {
    const { limits } = parsePluginQuota(
      "synthetic",
      { Groups: [{ Buckets: [{ Window: "weekly", RemainingFraction: 0 }] }] },
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
});

describe("hashIdentity redaction", () => {
  it("is deterministic, opaque, and never embeds input", () => {
    const a = hashIdentity(["id-1", "label"]);
    expect(a).toBe(hashIdentity(["id-1", "label"]));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain("id-1");
  });
});
