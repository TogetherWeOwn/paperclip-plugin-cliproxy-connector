import { describe, expect, it, vi } from "vitest";
import {
  type ManagementFetch,
  AUTH_FILES_PATH,
  AUTH_FILE_MODELS_PATH,
  authFileModelsPath,
  CliproxyAuthError,
  CliproxyBodyError,
  CliproxyClientApiClient,
  CliproxyConfigError,
  CliproxyManagementClient,
  CliproxyNetworkError,
  CliproxyNotFoundError,
  CliproxyRedirectError,
  isSafeAuthFileName,
  MODELS_PATH,
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

  it("refuses a redirect to the /v1/models path (management key never goes there)", async () => {
    // Revisited for v2 model → provider derivation: /v1/models is a live,
    // pinned path — but only for the *client* key through
    // CliproxyClientApiClient (tested below). The management client still
    // refuses it, so the management key can never travel to /v1 paths.
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: "/v1/models" } }));
    await expect(client(fetch).getAuthFiles()).rejects.toThrow(CliproxyRedirectError);
  });

  it("stops after too many redirects", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: AUTH_FILES_PATH } }));
    await expect(client(fetch).getAuthFiles()).rejects.toThrow(/too many redirects/);
    expect(fetch.mock.calls.length).toBeGreaterThan(1);
  });
});

describe("client API path (/v1/models, separate key)", () => {
  const CLIENT_KEY = "CLIENT-KEY-MATERIAL-abc";

  function modelsClient(fetchImpl?: ManagementFetch) {
    return new CliproxyClientApiClient({
      baseUrl: "http://127.0.0.1:8317",
      key: CLIENT_KEY,
      fetchImpl,
    });
  }

  it("pins the models path and GETs it with Bearer auth", async () => {
    expect(MODELS_PATH).toBe("/v1/models");
    let seen: { headers?: Headers } = {};
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      seen = { headers: new Headers(init?.headers) };
      return json(200, { data: [] });
    });
    const body = await modelsClient(fetch).getModels();
    expect(body).toEqual({ data: [] });
    expect(seen.headers?.get("Authorization")).toBe(`Bearer ${CLIENT_KEY}`);
  });

  it("sends the client key only to /v1/models, never to management paths", async () => {
    const fetch = vi.fn(async () => json(200, { data: [] }));
    await modelsClient(fetch).getModels();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String((fetch.mock.calls[0] as unknown as unknown[])[0])).toBe(
      "http://127.0.0.1:8317/v1/models",
    );
  });

  it("rejects an empty client key before any network happens", async () => {
    const fetch = vi.fn(async () => json(200, {}));
    const c = () =>
      new CliproxyClientApiClient({ baseUrl: "http://127.0.0.1:8317", key: "" });
    expect(c).toThrow(CliproxyConfigError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects non-loopback base URLs without touching the network", () => {
    expect(
      () =>
        new CliproxyClientApiClient({ baseUrl: "https://cliproxy.example.com", key: CLIENT_KEY }),
    ).toThrow(CliproxyConfigError);
  });

  it("maps 401 to CliproxyAuthError without the client key in the message", async () => {
    const fetch = vi.fn(async () => new Response("denied", { status: 401 }));
    const err = await modelsClient(fetch)
      .getModels()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliproxyAuthError);
    expect((err as Error).message).not.toContain(CLIENT_KEY);
  });

  it("refuses a redirect from /v1/models to a management path", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: AUTH_FILES_PATH } }));
    await expect(modelsClient(fetch).getModels()).rejects.toThrow(CliproxyRedirectError);
  });

  it("refuses to propagate a body containing client-key material", async () => {
    const fetch = vi.fn(async () => json(200, { echoed: CLIENT_KEY }));
    await expect(modelsClient(fetch).getModels()).rejects.toThrow(CliproxyBodyError);
  });
});

describe("served-set path (GET auth-files/models?name=<file>, same management key)", () => {
  it("pins the served-set path and validates the name as a single safe value", () => {
    expect(AUTH_FILE_MODELS_PATH).toBe("/v0/management/auth-files/models");
    expect(authFileModelsPath("claude-file")).toBe(
      "/v0/management/auth-files/models?name=claude-file",
    );
    expect(isSafeAuthFileName("auth1.json")).toBe(true);
    // CLIProxy OAuth flows generate email-style file names — these must fetch,
    // not fail closed (otherwise those credentials lose live served evidence).
    expect(isSafeAuthFileName("antigravity-user@example.com.json")).toBe(true);
    expect(isSafeAuthFileName("claude+work.json")).toBe(true);
    expect(authFileModelsPath("antigravity-user@example.com.json")).toBe(
      "/v0/management/auth-files/models?name=antigravity-user%40example.com.json",
    );
    for (const bad of ["../config", "..%2Fconfig", "a/b", "", ".", "x y", "api-call", "a".repeat(300)]) {
      expect(isSafeAuthFileName(bad)).toBe(false);
    }
  });

  it("rejects hostile names before any network happens", async () => {
    for (const bad of ["../config", "a/b", "api-call"]) {
      const fetch = vi.fn(async () => json(200, {}));
      await expect(client(fetch).getAuthFileModels(bad)).rejects.toThrow(CliproxyConfigError);
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("GETs the served set with the management key header", async () => {
    let seen: { url?: string; headers?: Headers } = {};
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen = { url, headers: new Headers(init?.headers) };
      return json(200, { data: [] });
    });
    const body = await client(fetch).getAuthFileModels("claude-file");
    expect(body).toEqual({ data: [] });
    expect(seen.url).toBe("http://127.0.0.1:8317/v0/management/auth-files/models?name=claude-file");
    expect(seen.headers?.get("X-Test-Key")).toBe(KEY);
  });

  it("fetches an email-style file name through the pinned shape", async () => {
    let seenUrl = "";
    const fetch = vi.fn(async (url: string) => {
      seenUrl = url;
      return json(200, { data: [] });
    });
    await client(fetch).getAuthFileModels("antigravity-user@example.com.json");
    expect(seenUrl).toBe(
      "http://127.0.0.1:8317/v0/management/auth-files/models?name=antigravity-user%40example.com.json",
    );
  });

  it("maps 404 to CliproxyNotFoundError (degradation, never the strike budget)", async () => {
    const fetch = vi.fn(async () => new Response("nope", { status: 404 }));
    const err = await client(fetch)
      .getAuthFileModels("claude-file")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliproxyNotFoundError);
    expect((err as Error).message).not.toContain(KEY);
  });

  it("maps 401 to CliproxyAuthError (same strike rules as every management GET)", async () => {
    const fetch = vi.fn(async () => new Response("denied", { status: 401 }));
    const err = await client(fetch)
      .getAuthFileModels("claude-file")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliproxyAuthError);
  });

  it("refuses a redirect to a served-set path with an unsafe name", async () => {
    const fetch = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "/v0/management/auth-files/models?name=..%2Fconfig" } }),
    );
    await expect(client(fetch).getAuthFiles()).rejects.toThrow(CliproxyRedirectError);
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
