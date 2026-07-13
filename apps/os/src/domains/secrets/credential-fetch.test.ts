import { describe, expect, test, vi } from "vitest";
import { fetchWithCredentialRedirects, MAX_CREDENTIAL_REDIRECTS } from "./credential-fetch.ts";

describe("fetchWithCredentialRedirects", () => {
  test("preserves response.webSocket on WebSocket upgrade responses", async () => {
    // undici/Node rejects status 101 in the Response constructor; workerd
    // accepts it. Use a normal status and attach `webSocket` the way the
    // runtime does after a successful upgrade — sanitize must still keep it.
    const upstreamSocket = { tag: "upstream-ws" };
    const upstream = new Response(null, { status: 200, statusText: "OK" });
    Object.defineProperty(upstream, "webSocket", {
      configurable: true,
      value: upstreamSocket,
    });

    const response = await fetchWithCredentialRedirects(
      new Request("https://allowed.example/ws", { headers: { Upgrade: "websocket" } }),
      { fetcher: async () => upstream },
    );

    expect(response.webSocket).toBe(upstreamSocket);
    expect(response.url).toBe("");
  });

  test("removes the credential-bearing upstream URL from terminal response metadata", async () => {
    const upstream = await fetch("data:application/json,%7B%22ok%22%3Atrue%7D");
    expect(upstream.url).not.toBe("");

    const response = await fetchWithCredentialRedirects(
      new Request("https://allowed.example/bot-url-secret/getMe"),
      { fetcher: async () => upstream },
    );

    expect(response.url).toBe("");
    expect(response.redirected).toBe(false);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  test("removes URL-bearing terminal response headers", async () => {
    const response = await fetchWithCredentialRedirects(
      new Request("https://allowed.example/bot-secret/getMe"),
      {
        fetcher: async () =>
          new Response("provider body", {
            headers: {
              "content-location": "https://allowed.example/bot-secret/getMe",
              location: "https://allowed.example/bot-secret/next",
              refresh: "0; url=https://allowed.example/bot-secret/next",
              "x-provider-header": "preserved",
            },
          }),
      },
    );

    expect(response.headers.get("content-location")).toBeNull();
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("refresh")).toBeNull();
    expect(response.headers.get("x-provider-header")).toBe("preserved");
    await expect(response.text()).resolves.toBe("provider body");
  });

  test("replaces credential-bearing fetch errors with a stable error code", async () => {
    await expect(
      fetchWithCredentialRedirects(new Request("https://allowed.example/bot-secret/getMe"), {
        fetcher: async (request) => {
          throw new Error(`failed to fetch ${request.url}`);
        },
      }),
    ).rejects.toMatchObject({ code: "secret_fetch_failed", message: "secret_fetch_failed" });
  });

  test("follows a relative same-origin redirect with manual mode and retained credentials", async () => {
    const requests: Request[] = [];
    const assertUrlAllowed = vi.fn();
    const fetcher = vi.fn(async (request: Request) => {
      requests.push(request.clone() as unknown as Request);
      return requests.length === 1
        ? new Response(null, { headers: { location: "/terminal" }, status: 302 })
        : Response.json({ ok: true });
    });

    const response = await fetchWithCredentialRedirects(
      new Request("https://allowed.example/start", {
        headers: { authorization: "Bearer secret" },
      }),
      { assertUrlAllowed, fetcher },
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(requests.map((request) => request.url)).toEqual([
      "https://allowed.example/start",
      "https://allowed.example/terminal",
    ]);
    expect(requests.every((request) => request.redirect === "manual")).toBe(true);
    expect(requests[1]!.headers.get("authorization")).toBe("Bearer secret");
    expect(assertUrlAllowed).toHaveBeenCalledWith("https://allowed.example/start");
    expect(assertUrlAllowed).toHaveBeenCalledWith("https://allowed.example/terminal");
  });

  test("rejects a cross-origin redirect before forwarding any credential-bearing request", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(null, {
          headers: { location: "https://attacker.example/capture" },
          status: 307,
        }),
    );

    await expect(
      fetchWithCredentialRedirects(
        new Request("https://allowed.example/start", {
          headers: { "x-api-key": "platform-secret" },
        }),
        { fetcher },
      ),
    ).rejects.toMatchObject({ code: "secret_not_allowed_for_origin" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("preserves a credential-bearing POST body across a same-origin 307", async () => {
    const requests: Request[] = [];
    const fetcher = vi.fn(async (request: Request) => {
      requests.push(request.clone() as unknown as Request);
      return requests.length === 1
        ? new Response(null, { headers: { location: "/terminal" }, status: 307 })
        : Response.json({ ok: true });
    });

    await fetchWithCredentialRedirects(
      new Request("https://allowed.example/start", {
        body: "refresh_token=secret",
        headers: { authorization: "Basic client-secret" },
        method: "POST",
      }),
      { fetcher },
    );

    expect(requests[1]).toMatchObject({ method: "POST" });
    expect(requests[1]!.headers.get("authorization")).toBe("Basic client-secret");
    await expect(requests[1]!.text()).resolves.toBe("refresh_token=secret");
  });

  test("bounds redirect chains and applies standard 303 POST-to-GET rewriting", async () => {
    const requests: Request[] = [];
    const fetcher = vi.fn(async (request: Request) => {
      requests.push(request.clone() as unknown as Request);
      return new Response(null, {
        headers: { location: `/hop-${requests.length}` },
        status: requests.length === 1 ? 303 : 307,
      });
    });

    await expect(
      fetchWithCredentialRedirects(
        new Request("https://allowed.example/start", {
          body: "refresh_token=secret",
          headers: {
            "content-length": "20",
            "content-type": "application/x-www-form-urlencoded",
          },
          method: "POST",
        }),
        { fetcher },
      ),
    ).rejects.toMatchObject({ code: "secret_fetch_failed" });

    expect(fetcher).toHaveBeenCalledTimes(MAX_CREDENTIAL_REDIRECTS + 1);
    expect(requests[1]).toMatchObject({ method: "GET" });
    expect(requests[1]!.headers.has("content-length")).toBe(false);
    expect(requests[1]!.headers.has("content-type")).toBe(false);
    await expect(requests[1]!.text()).resolves.toBe("");
  });
});
