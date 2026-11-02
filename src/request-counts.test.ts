import { describe, expect, it } from "vitest";
import { parseApiKeyUsage, RequestCountsBodyError } from "./request-counts.js";

const NOW = "2026-11-01T12:00:00.000Z";

// Composite `base_url|api_key` keys are deliberately fixture-shaped: obviously
// fake values that exercise the parse boundary without resembling real key
// material.
const KEY_A = "https://example.invalid|fixture-key-alpha";
const KEY_B = "https://example.invalid|fixture-key-beta";
const KEY_C = "https://other.invalid|fixture-key-gamma";

function entry(over: Record<string, unknown> = {}) {
  return { success: 10, failed: 2, ...over };
}

describe("parseApiKeyUsage", () => {
  it("aggregates composite-key counters by provider and merges buckets", () => {
    const { lanes, warnings } = parseApiKeyUsage(
      {
        Anthropic: {
          [KEY_A]: entry({
            success: 10,
            failed: 2,
            recent_requests: [
              { time: "12:00", success: 6, failed: 1 },
              { time: "12:05", success: 4, failed: 1 },
            ],
          }),
          [KEY_B]: entry({
            success: 5,
            failed: 1,
            recent_requests: [{ time: "12:00", success: 5, failed: 0 }],
          }),
        },
        codex: { [KEY_C]: entry({ recent_requests: [] }) },
      },
      NOW,
    );
    expect(warnings).toEqual([]);
    // Normalized lowercase, sorted.
    expect(lanes.map((l) => l.provider)).toEqual(["anthropic", "codex"]);
    const anthropic = lanes[0];
    expect(anthropic).toMatchObject({ success: 15, failed: 3, total: 18, fetchedAt: NOW });
    // Same time label merges across keys.
    expect(anthropic.recent).toEqual([
      { time: "12:00", success: 11, failed: 1 },
      { time: "12:05", success: 4, failed: 1 },
    ]);
    expect(lanes[1]).toMatchObject({ success: 10, failed: 2, total: 12, recent: [] });
  });

  it("never carries composite key material into the output (T1)", () => {
    const raw = {
      anthropic: {
        [KEY_A]: entry({ recent_requests: [{ time: "12:00", success: 1, failed: 0 }] }),
        [KEY_B]: entry(),
      },
    };
    const { lanes } = parseApiKeyUsage(raw, NOW);
    const dumped = JSON.stringify(lanes);
    expect(dumped).not.toContain("fixture-key-alpha");
    expect(dumped).not.toContain("fixture-key-beta");
    expect(dumped).not.toContain("example.invalid");
    for (const lane of lanes) {
      expect(Object.keys(lane).sort()).toEqual(
        ["failed", "fetchedAt", "provider", "recent", "success", "total"].sort(),
      );
    }
  });

  it("normalizes unknown providers and coerces bad counters to 0", () => {
    const { lanes, warnings } = parseApiKeyUsage(
      {
        "": { [KEY_A]: entry() },
        weird: { [KEY_B]: { success: -5, failed: "many", recent_requests: "nope" } },
      },
      NOW,
    );
    expect(lanes.map((l) => l.provider)).toEqual(["unknown", "weird"]);
    expect(lanes[0]).toMatchObject({ success: 10, failed: 2, total: 12 });
    expect(lanes[1]).toMatchObject({ success: 0, failed: 0, total: 0, recent: [] });
    // Non-array recent_requests drops with a warning count, and the two
    // present-but-unusable counters (-5, "many") warn instead of zeroing silently.
    expect(warnings.some((w) => w.includes("weird") && w.includes("dropped 1 malformed"))).toBe(true);
    expect(
      warnings.some((w) => w.includes("weird") && w.includes("2 malformed counters read as 0")),
    ).toBe(true);
  });

  it("skips malformed key entries and buckets with warning counts", () => {
    const { lanes, warnings } = parseApiKeyUsage(
      {
        anthropic: {
          [KEY_A]: entry(),
          broken: "not-an-entry",
          [KEY_B]: {
            success: 3,
            failed: 0,
            recent_requests: [
              { time: "12:00", success: 3, failed: 0 },
              { nope: true },
              "junk",
              { time: "x".repeat(65), success: 1, failed: 0 },
            ],
          },
        },
        "bad-provider": [1, 2],
      },
      NOW,
    );
    const anthropic = lanes.find((l) => l.provider === "anthropic");
    expect(anthropic).toMatchObject({ success: 13, failed: 2, total: 15 });
    expect(anthropic?.recent).toEqual([{ time: "12:00", success: 3, failed: 0 }]);
    expect(warnings.some((w) => w.includes("skipped 1 malformed"))).toBe(true);
    expect(warnings.some((w) => w.includes("dropped 3 malformed"))).toBe(true);
    expect(warnings.some((w) => w.includes("bad-provider"))).toBe(true);
    expect(lanes.some((l) => l.provider === "bad-provider")).toBe(false);
  });

  it("rejects non-object payloads outright", () => {
    for (const raw of [null, [], "junk", 42]) {
      expect(() => parseApiKeyUsage(raw, NOW)).toThrow(RequestCountsBodyError);
    }
  });
});
