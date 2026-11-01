import { describe, expect, it, vi } from "vitest";
import {
  CliproxyConfigError,
  CliproxyManagementClient,
  CliproxyNetworkError,
  CliproxyRedirectError,
} from "./cliproxy.js";
import { createLoopbackFetch } from "./loopback-fetch.js";

const BASE = "http://127.0.0.1:8317";
const KEY = "LOOPBACK-TEST-KEY-xyz";

function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe("construction", () => {
  it.each([
    "https://cliproxy.example.com",
    "http://192.168.1.10:8317",
    "http://10.0.0.5/",
    "http://[::ffff:127.0.0.1]:8317",
  ])("refuses a non-loopback base URL (%s) before any network happens", (baseUrl) => {
    const fetch = vi.fn(async () => json(200, {}));
    expect(() => createLoopbackFetch(baseUrl, { fetchImpl: fetch })).toThrow(CliproxyConfigError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses an unparseable base URL", () => {
    const fetch = vi.fn(async () => json(200, {}));
    expect(() => createLoopbackFetch("not a url at all", { fetchImpl: fetch })).toThrow(
      CliproxyConfigError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts every loopback spelling", () => {
    const fetch = vi.fn(async () => json(200, {}));
    for (const baseUrl of ["http://127.0.0.1:8317", "http://localhost:8317", "http://[::1]:8317"]) {
      expect(() => createLoopbackFetch(baseUrl, { fetchImpl: fetch })).not.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses https://localhost: the rewrite would mismatch a localhost certificate (TWO-749 Devin round 2)", () => {
    const fetch = vi.fn(async () => json(200, {}));
    expect(() => createLoopbackFetch("https://localhost:8317", { fetchImpl: fetch })).toThrow(
      /IP SAN|http:\/\/127/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("still accepts https://127.0.0.1 (operator certificate with an IP SAN)", () => {
    const fetch = vi.fn(async () => json(200, {}));
    expect(() => createLoopbackFetch("https://127.0.0.1:8317", { fetchImpl: fetch })).not.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("per-request guards", () => {
  it("refuses a target on another port without touching the network", async () => {
    const fetch = vi.fn(async () => json(200, {}));
    const guarded = createLoopbackFetch(BASE, { fetchImpl: fetch });
    await expect(guarded("http://127.0.0.1:9999/v0/management/auth-files")).rejects.toThrow(
      CliproxyConfigError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("treats localhost and 127.0.0.1 as the same canonical origin (no resolver)", async () => {
    let seenUrl = "";
    const fetch = vi.fn(async (url: string) => {
      seenUrl = url;
      return json(200, {});
    });
    const guarded = createLoopbackFetch(BASE, { fetchImpl: fetch });
    // Same port: `localhost` is rewritten to `127.0.0.1` before validation
    // and before the request leaves, so the OS resolver is never involved.
    await guarded("http://localhost:8317/v0/management/auth-files");
    expect(seenUrl).toBe("http://127.0.0.1:8317/v0/management/auth-files");
  });

  it("fetches a localhost base URL as the 127.0.0.1 literal", async () => {
    let seenUrl = "";
    const fetch = vi.fn(async (url: string) => {
      seenUrl = url;
      return json(200, {});
    });
    const guarded = createLoopbackFetch("http://localhost:8317", { fetchImpl: fetch });
    await guarded("http://localhost:8317/v0/management/auth-files");
    expect(seenUrl).toBe("http://127.0.0.1:8317/v0/management/auth-files");
  });

  it("refuses an off-loopback target without touching the network", async () => {
    const fetch = vi.fn(async () => json(200, {}));
    const guarded = createLoopbackFetch(BASE, { fetchImpl: fetch });
    await expect(guarded("https://evil.example/x")).rejects.toThrow(CliproxyConfigError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a non-GET/POST method without touching the network", async () => {
    const fetch = vi.fn(async () => json(200, {}));
    const guarded = createLoopbackFetch(BASE, { fetchImpl: fetch });
    await expect(
      guarded(`${BASE}/v0/management/auth-files`, { method: "PUT", body: "{}" }),
    ).rejects.toThrow(/GET and the pinned api-call POST only/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("GETs the configured origin, passing headers through", async () => {
    let seen: { url?: string; init?: RequestInit } = {};
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return json(200, { ok: true });
    });
    const guarded = createLoopbackFetch(BASE, { fetchImpl: fetch });
    const res = await guarded(`${BASE}/v0/management/auth-files`, {
      headers: { "X-Test-Key": KEY },
    });
    expect(await res.json()).toEqual({ ok: true });
    expect(seen.url).toBe(`${BASE}/v0/management/auth-files`);
    expect(seen.init?.method).toBe("GET");
    expect(new Headers(seen.init?.headers).get("X-Test-Key")).toBe(KEY);
  });

  it("preserves the pinned api-call POST method and body", async () => {
    let seen: { url?: string; init?: RequestInit } = {};
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return json(200, { status_code: 200, header: {}, body: "{}" });
    });
    const guarded = createLoopbackFetch(BASE, { fetchImpl: fetch });
    await guarded(`${BASE}/v0/management/api-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auth_index: "idx1" }),
    });
    expect(seen.url).toBe(`${BASE}/v0/management/api-call`);
    expect(seen.init?.method).toBe("POST");
    expect(seen.init?.body).toBe(JSON.stringify({ auth_index: "idx1" }));
  });

  it("refuses a POST outside the pinned api-call path", async () => {
    const fetch = vi.fn(async () => json(200, {}));
    const guarded = createLoopbackFetch(BASE, { fetchImpl: fetch });
    await expect(
      guarded(`${BASE}/v0/management/config`, { method: "POST", body: "{}" }),
    ).rejects.toThrow(/POST only to the pinned api-call path/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a POST to the api-call path with a query string", async () => {
    const fetch = vi.fn(async () => json(200, {}));
    const guarded = createLoopbackFetch(BASE, { fetchImpl: fetch });
    await expect(
      guarded(`${BASE}/v0/management/api-call?debug=1`, { method: "POST", body: "{}" }),
    ).rejects.toThrow(/POST only to the pinned api-call path/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a GET to another management path still passes the transport", async () => {
    const fetch = vi.fn(async () => json(200, { ok: true }));
    const guarded = createLoopbackFetch(BASE, { fetchImpl: fetch });
    const res = await guarded(`${BASE}/v0/management/auth-files`);
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("forces redirect: manual even when the caller asks to follow", async () => {
    let seenRedirect: RequestRedirect | undefined;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      seenRedirect = init?.redirect;
      return json(200, {});
    });
    const guarded = createLoopbackFetch(BASE, { fetchImpl: fetch });
    await guarded(`${BASE}/v0/management/auth-files`, { redirect: "follow" });
    expect(seenRedirect).toBe("manual");
  });

  it("never follows a redirect itself: one underlying call, the 3xx surfaces", async () => {
    const fetch = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "/v0/management/plugins/x/quota" } }),
    );
    const guarded = createLoopbackFetch(BASE, { fetchImpl: fetch });
    const res = await guarded(`${BASE}/v0/management/auth-files`);
    expect(res.status).toBe(302);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("attaches an abort signal (timeout budget) and keeps a caller signal", async () => {
    let seen: unknown = null;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      seen = init?.signal ?? null;
      return json(200, {});
    });
    const guarded = createLoopbackFetch(BASE, { fetchImpl: fetch });
    await guarded(`${BASE}/v0/management/auth-files`);
    expect(seen).toBeInstanceOf(AbortSignal);
    const controller = new AbortController();
    await guarded(`${BASE}/v0/management/auth-files`, { signal: controller.signal });
    expect(seen).toBe(controller.signal);
  });

  it("maps a network failure to CliproxyNetworkError without key material", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const guarded = createLoopbackFetch(BASE, { fetchImpl: fetch });
    const err = await guarded(`${BASE}/v0/management/auth-files`, {
      headers: { "X-Test-Key": KEY },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliproxyNetworkError);
    expect((err as Error).message).not.toContain(KEY);
  });

  it("keeps the underlying error name on the wrapper (TWO-749 CodeRabbit)", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const guarded = createLoopbackFetch(BASE, { fetchImpl: fetch });
    // A query string rides along: the failure message must still carry the
    // pathname only — never the query, headers or key material.
    const err = await guarded(`${BASE}/v0/management/auth-files?name=sentinel-q`).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliproxyNetworkError);
    // The management client reports only `err.name`: it must read
    // `TypeError`, not the collapsed `Error`.
    expect((err as Error).name).toBe("TypeError");
    expect((err as Error).message).toContain("/v0/management/auth-files");
    expect((err as Error).message).not.toContain("sentinel-q");
    expect((err as Error).message).not.toContain(KEY);
  });
});

describe("composition with the management client (TWO-749)", () => {
  function clientWith(stub: (url: string, init?: RequestInit) => Promise<Response>) {
    return new CliproxyManagementClient({
      baseUrl: BASE,
      keyHeader: "X-Test-Key",
      key: KEY,
      fetchImpl: createLoopbackFetch(BASE, { fetchImpl: stub as never }),
    });
  }

  it("a path off the allow-list is refused before any network happens", async () => {
    const stub = vi.fn(async () => json(200, {}));
    await expect(clientWith(stub).getJson("/v0/management/api-call")).rejects.toThrow(
      CliproxyConfigError,
    );
    expect(stub).not.toHaveBeenCalled();
  });

  it("a redirect escaping the loopback origin is refused after exactly one hop", async () => {
    const stub = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }),
    );
    await expect(clientWith(stub).getAuthFiles()).rejects.toThrow(CliproxyRedirectError);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("the happy path still reaches the loopback origin with the key header", async () => {
    let seen: { url?: string; headers?: Headers } = {};
    const stub = vi.fn(async (url: string, init?: RequestInit) => {
      seen = { url, headers: new Headers(init?.headers) };
      return json(200, [{ id: "a" }]);
    });
    const body = await clientWith(stub).getAuthFiles();
    expect(body).toEqual([{ id: "a" }]);
    expect(seen.url).toBe(`${BASE}/v0/management/auth-files`);
    expect(seen.headers?.get("X-Test-Key")).toBe(KEY);
  });

  it("the pinned api-call POST composes through the same guarded transport", async () => {
    let seen: { url?: string; method?: string; body?: unknown } = {};
    const stub = vi.fn(async (url: string, init?: RequestInit) => {
      seen = { url, method: init?.method, body: init?.body };
      return json(200, { status_code: 200, header: {}, body: JSON.stringify({ ok: true }) });
    });
    const result = await clientWith(stub).postApiCall("devin", "idx1");
    expect(result).toEqual({ statusCode: 200, body: { ok: true } });
    expect(seen.url).toBe(`${BASE}/v0/management/api-call`);
    expect(seen.method).toBe("POST");
    expect(String(seen.body)).toContain("$TOKEN$");
  });
});
