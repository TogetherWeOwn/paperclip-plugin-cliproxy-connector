import { describe, expect, it, vi } from "vitest";
import {
  fetchOpenRouterCredits,
  OPENROUTER_CREDITS_URL,
  OPENROUTER_HOST,
  OPENROUTER_MAX_BYTES,
  OpenRouterBodyError,
  parseOpenRouterCredits,
  type OpenRouterFetch,
} from "./openrouter.js";

const NOW = "2026-11-01T12:00:00.000Z";
const SECRET = "or-fixture-secret-not-a-real-key";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function okBody(over: Record<string, unknown> = {}) {
  return { data: { total_credits: 100, total_usage: 37.5, ...over } };
}

describe("parseOpenRouterCredits", () => {
  it("projects the four stored fields and nothing else", () => {
    const spend = parseOpenRouterCredits(okBody(), NOW);
    expect(spend).toEqual({
      provider: "openrouter",
      totalCredits: 100,
      totalUsage: 37.5,
      fetchedAt: NOW,
    });
  });

  it("accepts camelCase aliases", () => {
    const spend = parseOpenRouterCredits({ data: { totalCredits: 10, totalUsage: 4 } }, NOW);
    expect(spend).toMatchObject({ totalCredits: 10, totalUsage: 4 });
  });

  it("rejects non-objects, missing data, negatives and non-finite numbers", () => {
    expect(() => parseOpenRouterCredits(null, NOW)).toThrow(OpenRouterBodyError);
    expect(() => parseOpenRouterCredits([], NOW)).toThrow(OpenRouterBodyError);
    expect(() => parseOpenRouterCredits({}, NOW)).toThrow(OpenRouterBodyError);
    expect(() => parseOpenRouterCredits({ data: null }, NOW)).toThrow(OpenRouterBodyError);
    expect(() => parseOpenRouterCredits({ data: { total_usage: 1 } }, NOW)).toThrow(
      /total_credits/,
    );
    expect(() => parseOpenRouterCredits({ data: { total_credits: -1, total_usage: 0 } }, NOW)).toThrow(
      OpenRouterBodyError,
    );
    expect(() =>
      parseOpenRouterCredits({ data: { total_credits: 1, total_usage: Infinity } }, NOW),
    ).toThrow(OpenRouterBodyError);
    expect(() =>
      parseOpenRouterCredits({ data: { total_credits: "100", total_usage: 0 } }, NOW),
    ).toThrow(OpenRouterBodyError);
  });
});

describe("fetchOpenRouterCredits", () => {
  it("GETs the fixed endpoint with the secret as Bearer and nothing else", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const httpFetch: OpenRouterFetch = vi.fn(async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return json(200, okBody());
    });
    const spend = await fetchOpenRouterCredits({ httpFetch, secret: SECRET, fetchedAt: NOW });
    expect(spend).toMatchObject({ provider: "openrouter", totalCredits: 100 });
    expect(seenUrl).toBe(OPENROUTER_CREDITS_URL);
    expect(seenUrl).toBe("https://openrouter.ai/api/v1/credits");
    expect(OPENROUTER_HOST).toBe("openrouter.ai");
    const headers = new Headers(seenInit?.headers);
    expect(seenInit?.method).toBe("GET");
    expect(headers.get("Authorization")).toBe(`Bearer ${SECRET}`);
    expect(seenInit?.redirect).toBe("manual");
  });

  it("maps 401/403 to a rotate-secret error without the secret in the message", async () => {
    for (const status of [401, 403]) {
      const httpFetch: OpenRouterFetch = async () => new Response("denied", { status });
      const err = await fetchOpenRouterCredits({ httpFetch, secret: SECRET, fetchedAt: NOW }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(OpenRouterBodyError);
      expect((err as Error).message).toMatch(/rotate/i);
      expect((err as Error).message).not.toContain(SECRET);
    }
  });

  it("maps other non-2xx, non-JSON and oversize bodies to body errors", async () => {
    const http: OpenRouterFetch = async () => new Response("boom", { status: 500 });
    await expect(fetchOpenRouterCredits({ httpFetch: http, secret: SECRET, fetchedAt: NOW })).rejects.toThrow(
      /HTTP 500/,
    );
    const html: OpenRouterFetch = async () => new Response("<html>", { status: 200 });
    await expect(
      fetchOpenRouterCredits({ httpFetch: html, secret: SECRET, fetchedAt: NOW }),
    ).rejects.toThrow(/non-JSON/);
    const big: OpenRouterFetch = async () => new Response("x".repeat(OPENROUTER_MAX_BYTES + 1), { status: 200 });
    await expect(fetchOpenRouterCredits({ httpFetch: big, secret: SECRET, fetchedAt: NOW })).rejects.toThrow(
      /cap/,
    );
  });

  it("maps transport failures without leaking the secret", async () => {
    const http: OpenRouterFetch = async () => {
      throw new TypeError("fetch failed");
    };
    const err = await fetchOpenRouterCredits({ httpFetch: http, secret: SECRET, fetchedAt: NOW }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OpenRouterBodyError);
    expect((err as Error).message).not.toContain(SECRET);
  });

  it("refuses to probe without a key", async () => {
    const httpFetch: OpenRouterFetch = vi.fn(async () => json(200, okBody()));
    await expect(fetchOpenRouterCredits({ httpFetch, secret: "", fetchedAt: NOW })).rejects.toThrow(
      /empty/,
    );
    expect(httpFetch).not.toHaveBeenCalled();
  });
});
