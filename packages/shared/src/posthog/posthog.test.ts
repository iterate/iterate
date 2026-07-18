import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyPosthogRequest } from "./posthog.ts";

describe("proxyPosthogRequest", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["static/array.js", "array/phc_test/config.js"])(
    "routes %s to PostHog's EU asset host",
    async (path) => {
      const upstream = vi.fn(async () => new Response("asset"));
      vi.stubGlobal("fetch", upstream);

      await proxyPosthogRequest({
        request: new Request(`https://os.iterate.com/e/${path}`),
        proxyPrefix: "/e",
      });

      expect(upstream).toHaveBeenCalledWith(
        `https://eu-assets.i.posthog.com/${path}`,
        expect.objectContaining({ method: "GET" }),
      );
    },
  );

  it("forwards every other SDK request to ingest without application cookies", async () => {
    const upstream = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", upstream);
    const request = new Request("https://os.iterate.com/e/s/?compression=gzip-js", {
      method: "POST",
      headers: {
        cookie: "session=secret",
        "cf-connecting-ip": "203.0.113.7",
        "content-type": "application/json",
        host: "os.iterate.com",
        origin: "https://os.iterate.com",
        referer: "https://os.iterate.com/projects/test?token=secret",
      },
      body: '{"snapshot":true}',
    });

    await proxyPosthogRequest({ request, proxyPrefix: "/e" });

    const [url, init] = upstream.mock.calls[0]!;
    expect(url).toBe("https://eu.i.posthog.com/s/?compression=gzip-js");
    const headers = new Headers(init.headers);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("origin")).toBe("https://os.iterate.com");
    expect(headers.get("referer")).toBe("https://os.iterate.com/projects/test?token=secret");
    expect(headers.get("host")).toBe("eu.i.posthog.com");
    expect(headers.get("x-forwarded-for")).toBe("203.0.113.7");
    expect(await new Response(init.body).text()).toBe('{"snapshot":true}');
  });
});
