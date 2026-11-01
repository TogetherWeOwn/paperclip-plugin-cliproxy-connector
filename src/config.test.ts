import { describe, expect, it } from "vitest";
import {
  effectiveReservePercent,
  graceMs,
  isLoopbackUrl,
  maxAgeMs,
  parseConfig,
} from "./config.js";

function valid(over: Record<string, unknown> = {}) {
  return {
    cliproxyBaseUrl: "http://127.0.0.1:8317",
    managementKeyHeader: "X-Test-Key",
    managementSecretRef: { uid: "secret-1" },
    prefixMap: { "acct-a": "conn-a" },
    audienceConfirmed: true,
    ...over,
  };
}

describe("isLoopbackUrl", () => {
  it.each([
    ["http://127.0.0.1:8317", true],
    ["http://localhost:8317/", true],
    ["http://[::1]:8317", true],
    ["https://127.0.0.1:8317", true],
    ["https://cliproxy.example.com", false],
    ["http://10.0.0.5:8317", false],
    ["not a url", false],
    ["ftp://127.0.0.1/x", false],
  ])("%s → %s", (input, expected) => {
    expect(isLoopbackUrl(input)).toBe(expected);
  });
});

describe("parseConfig", () => {
  it("accepts a valid config with defaults", () => {
    const { config, validation } = parseConfig(valid());
    expect(validation.ok).toBe(true);
    expect(config.syncIntervalMinutes).toBe(5);
    expect(config.reservePercent).toBe(10);
    expect(config.providerWindows.claude).toContain("5h");
  });

  it("fails loudly on security-relevant fields", () => {
    expect(parseConfig(valid({ cliproxyBaseUrl: "https://x.example" })).validation.errors.length).toBeGreaterThan(0);
    expect(parseConfig(valid({ managementKeyHeader: "" })).validation.errors).toContainEqual(
      expect.stringMatching(/managementKeyHeader is required/),
    );
    expect(parseConfig(valid({ managementSecretRef: undefined })).validation.errors).toContainEqual(
      expect.stringMatching(/managementSecretRef is required/),
    );
    // Legacy string UUID secrets fail closed.
    expect(
      parseConfig(valid({ managementSecretRef: "01234567-89ab-cdef-0123-456789abcdef" })).validation.errors,
    ).toContainEqual(expect.stringMatching(/secret_ref object/));
  });

  it("rejects out-of-range reserves and intervals", () => {
    expect(parseConfig(valid({ reservePercent: 0 })).validation.ok).toBe(false);
    expect(parseConfig(valid({ reservePercent: 50 })).validation.ok).toBe(false);
    expect(parseConfig(valid({ syncIntervalMinutes: 0 })).validation.ok).toBe(false);
  });

  it("rejects multi-segment prefixes", () => {
    const { validation } = parseConfig(valid({ prefixMap: { "a/b": "conn-a" } }));
    expect(validation.ok).toBe(false);
  });

  it("warns on empty maps and unconfirmed audience", () => {
    const { validation } = parseConfig(valid({ prefixMap: {}, audienceConfirmed: false }));
    expect(validation.ok).toBe(true);
    expect(validation.warnings.some((w) => w.includes("prefixMap is empty"))).toBe(true);
    expect(validation.warnings.some((w) => w.includes("audienceConfirmed"))).toBe(true);
  });

  it("warns when two prefixes share one connection", () => {
    const { validation } = parseConfig(valid({ prefixMap: { a: "conn-x", b: "conn-x" } }));
    expect(validation.warnings.some((w) => w.includes("conn-x"))).toBe(true);
  });

  it("accepts provider window overrides, lowercased", () => {
    const { config } = parseConfig(valid({ providerWindows: { CLAUDE: ["5H", "Custom"] } }));
    expect(config.providerWindows.claude).toEqual(["5h", "custom"]);
  });

  it("warns when an override empties a default allow-list (silent quota-blind)", () => {
    const { validation } = parseConfig(valid({ providerWindows: { claude: [] } }));
    expect(validation.ok).toBe(true);
    expect(validation.warnings.some((w) => w.includes("quota-blind fail-open"))).toBe(true);
  });
});

describe("effectiveReservePercent", () => {
  const { config } = parseConfig(valid({ reservePercent: 10, perPoolReservePercent: { "pool-x": 25 } }));
  it("prefers the per-pool override, then the pool threshold, then the default", () => {
    expect(effectiveReservePercent(config, { id: "pool-x", thresholdPercent: 90 })).toBe(25);
    expect(effectiveReservePercent(config, { id: "pool-y", thresholdPercent: 90 })).toBe(10);
    expect(effectiveReservePercent(config, { id: "pool-y" })).toBe(10);
  });

  it("ignores unusable pool thresholds instead of hard-gating", () => {
    expect(effectiveReservePercent(config, { id: "pool-y", thresholdPercent: 30 })).toBe(10);
    expect(effectiveReservePercent(config, { id: "pool-y", thresholdPercent: "high" })).toBe(10);
  });
});

describe("freshness math", () => {
  const { config } = parseConfig(valid({ syncIntervalMinutes: 5 }));
  it("derives sync-relative max age and grace", () => {
    expect(maxAgeMs(config)).toBe(10 * 60_000); // 2× sync interval
    expect(graceMs(config)).toBe(30 * 60_000); // 3× max age
  });
});
