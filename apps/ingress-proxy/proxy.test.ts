import { describe, expect, test } from "vitest";
import { buildUpstreamUrl, createUpstreamHeaders, deriveCandidateRootHosts } from "./proxy.ts";

function buildInboundRequest(params: {
  host: string;
  path: string;
  headers?: Record<string, string>;
}) {
  return new Request(`https://${params.host}${params.path}`, {
    headers: {
      host: params.host,
      ...(params.headers ?? {}),
    },
  });
}

describe("deriveCandidateRootHosts", () => {
  test("prefers exact, dunder, and subdomain candidates deterministically", () => {
    expect(deriveCandidateRootHosts("events__proj.ingress.iterate.com")).toEqual({
      exactRootHost: "events__proj.ingress.iterate.com",
      dunderRootHost: "proj.ingress.iterate.com",
      subhostRootHost: "ingress.iterate.com",
    });

    expect(deriveCandidateRootHosts("events.proj.ingress.iterate.com")).toEqual({
      exactRootHost: "events.proj.ingress.iterate.com",
      dunderRootHost: null,
      subhostRootHost: "proj.ingress.iterate.com",
    });
  });
});

describe("buildUpstreamUrl", () => {
  test("preserves the inbound path and query under the target base path", () => {
    const upstream = buildUpstreamUrl(
      new URL("https://target.fly.dev/base"),
      new URL("https://app.ingress.iterate.com/foo/bar?x=1"),
    );

    expect(upstream.toString()).toBe("https://target.fly.dev/base/foo/bar?x=1");
  });
});

describe("createUpstreamHeaders", () => {
  test("replaces stale forwarding headers with the inbound request context", () => {
    const request = buildInboundRequest({
      host: "app.ingress.iterate.com",
      path: "/foo",
      headers: {
        "x-forwarded-host": "stale.example.com",
        "x-forwarded-proto": "http",
        "x-forwarded-for": "1.2.3.4",
        "x-real-ip": "1.2.3.4",
        "cf-connecting-ip": "1.2.3.4",
        "true-client-ip": "1.2.3.4",
      },
    });

    const headers = createUpstreamHeaders(request, new URL("https://target.fly.dev/base"));

    expect(headers.get("host")).toBe("target.fly.dev");
    expect(headers.get("x-forwarded-host")).toBe("app.ingress.iterate.com");
    expect(headers.get("x-forwarded-proto")).toBe("https");
    expect(headers.get("x-forwarded-for")).toBe("1.2.3.4");
    expect(headers.get("x-real-ip")).toBe("1.2.3.4");
    expect(headers.get("cf-connecting-ip")).toBe("1.2.3.4");
    expect(headers.get("true-client-ip")).toBeNull();
  });
});
