import { describe, expect, it, vi } from "vitest";
import { createExternalEgressProxyFetch } from "./fetch-egress-proxy.ts";

describe("createExternalEgressProxyFetch", () => {
  it("rewrites requests through the configured proxy with forwarded headers", async () => {
    const nativeFetch = vi.fn(async (request: Request) => new Response(request.url));
    const proxiedFetch = createExternalEgressProxyFetch({
      fetch: nativeFetch,
      externalEgressProxy: "https://proxy.example.com",
    });

    const response = await proxiedFetch("https://api.example.com/v1/models?x=1", {
      headers: {
        authorization: "Bearer test",
      },
    });
    const request = nativeFetch.mock.calls[0]?.[0] as Request;

    expect(response.ok).toBe(true);
    expect(request.url).toBe("https://proxy.example.com/v1/models?x=1");
    expect(request.headers.get("host")).toBe("proxy.example.com");
    expect(request.headers.get("x-forwarded-host")).toBe("api.example.com");
    expect(request.headers.get("x-forwarded-proto")).toBe("https");
    expect(request.headers.get("authorization")).toBe("Bearer test");
  });

  it("preserves a proxy path prefix", async () => {
    const nativeFetch = vi.fn(async (request: Request) => new Response(request.url));
    const proxiedFetch = createExternalEgressProxyFetch({
      fetch: nativeFetch,
      externalEgressProxy: "https://proxy.example.com/egress",
    });

    await proxiedFetch("https://api.example.com/v1/models?x=1");
    const request = nativeFetch.mock.calls[0]?.[0] as Request;

    expect(request.url).toBe("https://proxy.example.com/egress/v1/models?x=1");
  });

  it("does not re-proxy requests already targeting the proxy origin", async () => {
    const nativeFetch = vi.fn(async (request: Request) => new Response(request.url));
    const proxiedFetch = createExternalEgressProxyFetch({
      fetch: nativeFetch,
      externalEgressProxy: "https://proxy.example.com/egress",
    });

    await proxiedFetch("https://proxy.example.com/health");
    const request = nativeFetch.mock.calls[0]?.[0] as Request;

    expect(request.url).toBe("https://proxy.example.com/health");
    expect(request.headers.get("x-forwarded-host")).toBeNull();
    expect(request.headers.get("x-forwarded-proto")).toBeNull();
  });

  it("preserves request method and body", async () => {
    const nativeFetch = vi.fn(async (request: Request) => new Response(await request.text()));
    const proxiedFetch = createExternalEgressProxyFetch({
      fetch: nativeFetch,
      externalEgressProxy: "https://proxy.example.com",
    });

    const response = await proxiedFetch("https://api.example.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ hello: "world" }),
    });
    const request = nativeFetch.mock.calls[0]?.[0] as Request;

    expect(request.method).toBe("POST");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe('{"hello":"world"}');
  });
});
