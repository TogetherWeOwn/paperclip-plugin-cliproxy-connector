import { describe, expect, it, vi } from "vitest";
import {
  type ManagementFetch,
  AUTH_FILES_PATH,
  CliproxyAuthError,
  CliproxyBodyError,
  CliproxyConfigError,
  CliproxyManagementClient,
  CliproxyNetworkError,
  CliproxyRedirectError,
  pluginQuotaPath,
} from "./cliproxy.js";

const KEY = "LIVE-KEY-MATERIAL-xyz789";

function client(fetchImpl?: ManagementFetch) {
  return new CliproxyManagementClient({
    baseUrl: "http://127.0.0.1:8317",
    keyHeader: "X-Test-Key",
    key: KEY,
    fetchImpl,
  });
}

function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe("construction and allow-list", () => {
  it("rejects non-loopback base URLs", () => {
    expect(
      () =>
        new CliproxyManagementClient({
          baseUrl: "https://cliproxy.example.com",
          keyHeader: "X-K",
          key: KEY,
        }),
    ).toThrow(CliproxyConfigError);
  });

  it("rejects paths outside the GET allow-list without touching the network", async () => {
    const fetch = vi.fn(async () => json(200, {}));
    await expect(client(fetch).getJson("/v0/management/api-call")).rejects.toThrow(
      CliproxyConfigError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("`api-call` can never be admitted, even via a plugin id", async () => {
    const fetch = vi.fn(async () => json(200, {}));
    await expect(
      client(fetch).getPluginQuota("evil-api-call-x"),
    ).rejects.toThrow(/api-call/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("attaches the key header only after origin validation, and sends GET", async () => {
    let seen: { method?: string; headers?: Headers } = {};
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      seen = { method: init?.method, headers: new Headers(init?.headers) };
      return json(200, { ok: true });
    });
    const body = await client(fetch).getAuthFiles();
    expect(body).toEqual({ ok: true });
    expect(seen.method).toBe("GET");
    expect(seen.headers?.get("X-Test-Key")).toBe(KEY);
    // No credentials anywhere else.
    expect(seen.headers?.get("Authorization")).toBeNull();
  });

  it("passes an abort signal (15 s timeout budget)", async () => {
    let signal: unknown = null;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      signal = init?.signal ?? null;
      return json(200, {});
    });
    await client(fetch).getAuthFiles();
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe("auth and error mapping", () => {
  it("maps 401/403 to CliproxyAuthError without the key in the message", async () => {
    for (const status of [401, 403]) {
      const fetch = vi.fn(async () => new Response("denied", { status }));
      const err = await client(fetch)
        .getAuthFiles()
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CliproxyAuthError);
      expect((err as Error).message).not.toContain(KEY);
      expect((err as CliproxyAuthError).status).toBe(status);
    }
  });

  it("maps 5xx to CliproxyNetworkError without key material", async () => {
    const fetch = vi.fn(async () => new Response("boom", { status: 500 }));
    const err = await client(fetch)
      .getAuthFiles()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliproxyNetworkError);
    expect((err as Error).message).not.toContain(KEY);
  });

  it("rejects non-JSON bodies", async () => {
    const fetch = vi.fn(async () => new Response("<html>nope</html>", { status: 200 }));
    await expect(client(fetch).getAuthFiles()).rejects.toThrow(CliproxyBodyError);
  });

  it("refuses to propagate a body containing key material", async () => {
    const fetch = vi.fn(async () => json(200, { echoed: KEY }));
    const err = await client(fetch)
      .getAuthFiles()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliproxyBodyError);
    expect((err as Error).message).toMatch(/key material/);
  });

  it("enforces the response size cap", async () => {
    const big = "x".repeat(100);
    const fetch = vi.fn(
      async (): Promise<Response> =>
        ({ status: 200, headers: new Headers(), body: null, text: async () => big }) as unknown as Response,
    );
    const tiny = new CliproxyManagementClient({
      baseUrl: "http://127.0.0.1:8317",
      keyHeader: "X-Test-Key",
      key: KEY,
      fetchImpl: fetch,
      maxBytes: 10,
    });
    await expect(tiny.getAuthFiles()).rejects.toThrow(CliproxyBodyError);
  });
});

describe("redirects", () => {
  it("follows a same-origin pinned-shape redirect", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      calls.push(url);
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "/v0/management/plugins/claude-quota/quota" },
        });
      }
      return json(200, { quota: [] });
    });
    const body = await client(fetch).getAuthFiles();
    expect(body).toEqual({ quota: [] });
    expect(calls).toHaveLength(2);
  });

  it("refuses a redirect that escapes the loopback origin", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }));
    await expect(client(fetch).getAuthFiles()).rejects.toThrow(CliproxyRedirectError);
  });

  it("refuses a redirect to a non-allow-listed path", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: "/v0/management/api-call" } }));
    await expect(client(fetch).getAuthFiles()).rejects.toThrow(CliproxyRedirectError);
  });

  it("refuses a redirect to the removed /v1/models path", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: "/v1/models" } }));
    await expect(client(fetch).getAuthFiles()).rejects.toThrow(CliproxyRedirectError);
  });

  it("stops after too many redirects", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: AUTH_FILES_PATH } }));
    await expect(client(fetch).getAuthFiles()).rejects.toThrow(/too many redirects/);
    expect(fetch.mock.calls.length).toBeGreaterThan(1);
  });
});

describe("pinned allow-list and plugin id validation (S1)", () => {
  it("pins the auth-files path and the plugin quota shape", () => {
    expect(AUTH_FILES_PATH).toBe("/v0/management/auth-files");
    expect(pluginQuotaPath("claude-quota")).toBe("/v0/management/plugins/claude-quota/quota");
  });

  it("rejects hostile plugin ids before any network happens", async () => {
    for (const bad of ["../config", "..%2Fconfig", "api-call", "evil-api-call-x", "a/b", "", ".", "x y"]) {
      const fetch = vi.fn(async () => json(200, {}));
      await expect(client(fetch).getPluginQuota(bad)).rejects.toThrow(CliproxyConfigError);
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("rejects percent-encoded api-call in the request path", async () => {
    const fetch = vi.fn(async () => json(200, {}));
    await expect(client(fetch).getJson("/v0/management/api%2Dcall")).rejects.toThrow(
      CliproxyConfigError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a decoded-traversal redirect target", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: "/v0/management/plugins/..%2Fconfig/quota" } }));
    await expect(client(fetch).getAuthFiles()).rejects.toThrow(CliproxyRedirectError);
  });
});
