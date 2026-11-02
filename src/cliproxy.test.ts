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
  apiCallTemplate,
  apiCallTemplateKeyForProvider,
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

  it("never admits the usage queue: reads would delete cpa-usage-keeper records", async () => {
    // The connector's quota view is sync-cache only. The usage-queue read is
    // destructive (it dequeues), so the pinned allow-list refuses it outright
    // — including percent-encoded spellings that decode to the same path.
    const fetch = vi.fn(async () => json(200, {}));
    for (const path of [
      "/v0/management/usage-queue",
      "/v0/management/usage-queue?limit=10",
      "/v0/management/%75sage-queue",
    ]) {
      await expect(client(fetch).getJson(path)).rejects.toThrow(CliproxyConfigError);
    }
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

  it("cancels the unread body on every non-success branch (TWO-749 Devin round 2)", async () => {
    function stubResponse(status: number, headers?: Record<string, string>) {
      const cancel = vi.fn(async () => {});
      const res = { status, headers: new Headers(headers), body: { cancel } } as unknown as Response;
      return { res, cancel };
    }
    // 401/403/404/5xx: the body is cancelled before the typed error leaves,
    // so loopback sockets return to the pool instead of lingering for GC.
    for (const status of [401, 403, 404, 500]) {
      const { res, cancel } = stubResponse(status);
      const fetch = vi.fn(async () => res);
      await expect(client(fetch).getAuthFiles()).rejects.toThrow();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    // Redirect refusal: the 3xx body is cancelled too, after exactly one hop.
    const { res, cancel } = stubResponse(302, { location: "https://evil.example/x" });
    const fetch = vi.fn(async () => res);
    await expect(client(fetch).getAuthFiles()).rejects.toThrow(CliproxyRedirectError);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the underlying error name on transport failures (TWO-749 CodeRabbit)", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const err = await client(fetch)
      .getAuthFiles()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliproxyNetworkError);
    expect((err as Error).name).toBe("TypeError");
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

describe("plugin quota auth_index (v8.0.49, per-file quota)", () => {
  it("builds the per-file quota path with exactly one auth_index parameter", () => {
    expect(pluginQuotaPath("claude-quota", "abc123")).toBe(
      "/v0/management/plugins/claude-quota/quota?auth_index=abc123",
    );
    // Legacy provider-level shape (older builds without auth_index).
    expect(pluginQuotaPath("claude-quota")).toBe("/v0/management/plugins/claude-quota/quota");
  });

  it("rejects hostile auth indexes before any network happens", async () => {
    for (const bad of [
      "",
      "  ",
      "../config",
      "..%2Fconfig",
      "a/b",
      "x y",
      "api-call",
      "evil-api-call-x",
      "a".repeat(200),
    ]) {
      const fetch = vi.fn(async () => json(200, {}));
      await expect(client(fetch).getPluginQuota("claude-quota", bad)).rejects.toThrow(
        CliproxyConfigError,
      );
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("GETs the per-file quota with the management key header", async () => {
    let seen: { url?: string; headers?: Headers } = {};
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen = { url, headers: new Headers(init?.headers) };
      return json(200, { Groups: [] });
    });
    const body = await client(fetch).getPluginQuota("claude-quota", "abc123");
    expect(body).toEqual({ Groups: [] });
    expect(seen.url).toBe(
      "http://127.0.0.1:8317/v0/management/plugins/claude-quota/quota?auth_index=abc123",
    );
    expect(seen.headers?.get("X-Test-Key")).toBe(KEY);
  });

  it("allow-lists exactly one auth_index parameter and validates its value", async () => {
    const ok = vi.fn(async () => json(200, {}));
    await client(ok).getJson("/v0/management/plugins/claude-quota/quota?auth_index=abc123");
    expect(ok).toHaveBeenCalledTimes(1);
    for (const bad of [
      "/v0/management/plugins/claude-quota/quota?auth_index=",
      "/v0/management/plugins/claude-quota/quota?auth_index=a%2Fb",
      "/v0/management/plugins/claude-quota/quota?auth_index=abc&other=1",
      "/v0/management/plugins/claude-quota/quota?other=1",
      "/v0/management/plugins/claude-quota/quota?auth_index=a&auth_index=b",
      "/v0/management/plugins/claude-quota/quota?auth_index=api-call",
    ]) {
      const fetch = vi.fn(async () => json(200, {}));
      await expect(client(fetch).getJson(bad)).rejects.toThrow(CliproxyConfigError);
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("refuses a redirect to a quota path with an unsafe query", async () => {
    const fetch = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "/v0/management/plugins/claude-quota/quota?auth_index=..%2Fconfig" } }),
    );
    await expect(client(fetch).getAuthFiles()).rejects.toThrow(CliproxyRedirectError);
  });
});

describe("pinned api-call POST (three frozen templates)", () => {
  const envelope = (statusCode: number, body: unknown) =>
    json(200, { status_code: statusCode, header: {}, body: JSON.stringify(body) });

  it("rejects unknown template keys before any network happens", async () => {
    const fetch = vi.fn(async () => json(200, {}));
    await expect(client(fetch).postApiCall("openai", "abc123")).rejects.toThrow(
      CliproxyConfigError,
    );
    await expect(client(fetch).postApiCall("", "abc123")).rejects.toThrow(
      CliproxyConfigError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resolves template keys by exact provider word only (no fuzzy matching)", async () => {
    expect(apiCallTemplateKeyForProvider("antigravity")).toBe("antigravity");
    expect(apiCallTemplateKeyForProvider("devin")).toBe("devin");
    // Meta is panel-only (no template exists), and fuzzy/substring lookalikes
    // must never resolve: a Gemini credential must not travel through the
    // Antigravity request, nor a made-up word through any request.
    for (const word of ["meta", " Meta ", "gemini", "gemini-cli", "metafoo", "metas", "mydevin", "claude", "", "constructor"]) {
      expect(apiCallTemplateKeyForProvider(word)).toBeNull();
    }
  });

  it("resolves antigravity quota keys in panel try order, nothing else", async () => {
    const { apiCallQuotaTemplateKeysForProvider } = await import("./cliproxy.js");
    expect(apiCallQuotaTemplateKeysForProvider("antigravity")).toEqual([
      "antigravity-quota-daily",
      "antigravity-quota-sandbox",
      "antigravity-quota-cloudcode",
    ]);
    expect(apiCallQuotaTemplateKeysForProvider(" Antigravity ")).toEqual([
      "antigravity-quota-daily",
      "antigravity-quota-sandbox",
      "antigravity-quota-cloudcode",
    ]);
    for (const word of ["meta", "devin", "gemini", "", "constructor"]) {
      expect(apiCallQuotaTemplateKeysForProvider(word)).toEqual([]);
    }
  });

  it("validates project ids strictly (GCP-shaped, no substitution games)", async () => {
    const { isSafeApiCallProjectId } = await import("./cliproxy.js");
    for (const good of ["my-project-123", "proj:domain/x", "a", "A0._-:/b"]) {
      expect(isSafeApiCallProjectId(good)).toBe(true);
    }
    for (const bad of [
      "",
      "has space",
      "has\"quote",
      "has'quote",
      "back\\slash",
      "semi;colon",
      "dollar$token",
      "$TOKEN$",
      "PROJECT_ID_SENTINEL",
      "{{project}}",
      "../traversal",
      "a".repeat(200),
    ]) {
      expect(isSafeApiCallProjectId(bad)).toBe(false);
    }
  });

  it("rejects inherited prototype keys, not only unknown names", async () => {
    const fetch = vi.fn(async () => json(200, {}));
    for (const key of ["constructor", "toString", "hasOwnProperty"]) {
      await expect(client(fetch).postApiCall(key, "abc123")).rejects.toThrow(
        CliproxyConfigError,
      );
      expect(() => apiCallTemplate(key)).toThrow(CliproxyConfigError);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns a defensive copy that cannot mutate the frozen template table", async () => {
    const selected = apiCallTemplate("antigravity");
    selected.url = "https://example.invalid/";
    selected.headers.Authorization = "tampered";
    const fresh = apiCallTemplate("antigravity");
    expect(fresh.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist");
    expect(fresh.headers.Authorization).toBe("Bearer $TOKEN$");
  });

  it("rejects untrusted auth indexes before any network happens", async () => {
    for (const bad of ["", "../config", "a/b", "x y", "api-call", "a".repeat(200)]) {
      const fetch = vi.fn(async () => json(200, {}));
      await expect(client(fetch).postApiCall("devin", bad)).rejects.toThrow(
        CliproxyConfigError,
      );
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("POSTs the exact frozen devin template with the auth index as the only variable", async () => {
    let seen: { url?: string; method?: string; headers?: Headers; body?: string } = {};
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen = {
        url,
        method: init?.method,
        headers: new Headers(init?.headers),
        body: init?.body as string,
      };
      return envelope(200, { userStatus: {} });
    });
    const result = await client(fetch).postApiCall("devin", "abc123");
    expect(seen.url).toBe("http://127.0.0.1:8317/v0/management/api-call");
    expect(seen.method).toBe("POST");
    expect(seen.headers?.get("X-Test-Key")).toBe(KEY);
    expect(seen.headers?.get("Content-Type")).toBe("application/json");
    const sent = JSON.parse(seen.body as string) as Record<string, unknown>;
    expect(sent).toEqual({
      auth_index: "abc123",
      method: "POST",
      url: "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus",
      header: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      data: '{"metadata":{"ideName":"chisel","ideVersion":"3000.10.21","apiKey":"$TOKEN$","locale":"en","os":"darwin","extensionVersion":"3000.10.21","clientName":"chisel"}}',
    });
    // The $TOKEN$ placeholder is substituted server-side by CLIProxy — the
    // plugin sends it verbatim and never handles credential material.
    expect(seen.body).toContain("$TOKEN$");
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ userStatus: {} });
  });

  it("POSTs the exact frozen antigravity quota template with the project id in the body", async () => {
    let seen: { url?: string; method?: string; body?: string } = {};
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen = { url, method: init?.method, body: init?.body as string };
      return envelope(200, { groups: [] });
    });
    const result = await client(fetch).postApiCall("antigravity-quota-daily", "abc123", {
      projectId: "my-project-123",
    });
    expect(seen.url).toBe("http://127.0.0.1:8317/v0/management/api-call");
    expect(seen.method).toBe("POST");
    const sent = JSON.parse(seen.body as string) as Record<string, unknown>;
    expect(sent).toEqual({
      auth_index: "abc123",
      method: "POST",
      url: "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      header: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: "Bearer $TOKEN$",
        "User-Agent": "antigravity/hub/2.23.0 darwin/arm64",
      },
      // The project id is injected via JSON.stringify — it can never break
      // out of its JSON string, and the literal sentinel never travels.
      data: '{"project":"my-project-123"}',
    });
    expect(seen.body).toContain("$TOKEN$");
    expect(seen.body).not.toContain("PROJECT_ID_SENTINEL");
    expect(result.statusCode).toBe(200);
  });

  it("rejects quota calls with a missing or untrusted project id before any network happens", async () => {
    for (const opts of [undefined, {}, { projectId: "" }, { projectId: "../evil" }, { projectId: "has space" }, { projectId: "$TOKEN$" }, { projectId: "PROJECT_ID_SENTINEL" }]) {
      const fetch = vi.fn(async () => json(200, {}));
      await expect(
        client(fetch).postApiCall("antigravity-quota-sandbox", "abc123", opts),
      ).rejects.toThrow(CliproxyConfigError);
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("rejects a project id on a non-quota template (fail closed, no silent ignore)", async () => {
    const fetch = vi.fn(async () => json(200, {}));
    await expect(
      client(fetch).postApiCall("devin", "abc123", { projectId: "my-project-123" }),
    ).rejects.toThrow(CliproxyConfigError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("POSTs the exact frozen antigravity and devin templates", async () => {
    for (const [key, url, data] of [
      [
        "antigravity",
        "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
        '{"metadata":{"ideType":"ANTIGRAVITY"}}',
      ],
      [
        "devin",
        "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus",
        '{"metadata":{"ideName":"chisel","ideVersion":"3000.10.21","apiKey":"$TOKEN$","locale":"en","os":"darwin","extensionVersion":"3000.10.21","clientName":"chisel"}}',
      ],
    ] as const) {
      let body: string | undefined;
      const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        body = init?.body as string;
        return envelope(200, {});
      });
      await client(fetch).postApiCall(key, "idx1");
      const sent = JSON.parse(body as string) as Record<string, unknown>;
      expect(sent.url).toBe(url);
      expect(sent.data).toBe(data);
      expect(sent.auth_index).toBe("idx1");
    }
  });

  it("returns the upstream status without throwing (provider 4xx is a per-file warning, not a sync failure)", async () => {
    const fetch = vi.fn(async () => envelope(429, { error: "throttled" }));
    const result = await client(fetch).postApiCall("devin", "idx1");
    expect(result.statusCode).toBe(429);
    expect(result.body).toEqual({ error: "throttled" });
  });

  it("maps transport 401/403 to CliproxyAuthError (strike budget) and 404/5xx to the GET semantics", async () => {
    for (const status of [401, 403]) {
      const fetch = vi.fn(async () => new Response("denied", { status }));
      const err = await client(fetch)
        .postApiCall("devin", "idx1")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CliproxyAuthError);
      expect((err as Error).message).not.toContain(KEY);
    }
    {
      const fetch = vi.fn(async () => new Response("missing", { status: 404 }));
      const err = await client(fetch)
        .postApiCall("devin", "idx1")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CliproxyNotFoundError);
    }
    {
      const fetch = vi.fn(async () => new Response("boom", { status: 500 }));
      const err = await client(fetch)
        .postApiCall("devin", "idx1")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CliproxyNetworkError);
    }
  });

  it("rejects a non-object envelope and an envelope without an upstream status", async () => {
    for (const payload of [[], "ok", { header: {}, body: "{}" }, { status_code: "200", body: "{}" }]) {
      const fetch = vi.fn(async () => json(200, payload));
      const err = await client(fetch)
        .postApiCall("devin", "idx1")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CliproxyBodyError);
    }
  });

  it("refuses a redirect off the pinned api-call path", async () => {
    const fetch = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "/v0/management/auth-files" } }),
    );
    const err = await client(fetch)
      .postApiCall("devin", "idx1")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliproxyRedirectError);
  });

  it("the GET allow-list still refuses the api-call path outright", async () => {
    const fetch = vi.fn(async () => json(200, {}));
    await expect(client(fetch).getJson("/v0/management/api-call")).rejects.toThrow(
      CliproxyConfigError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
