import { describe, expect, test } from "vitest";
import {
  PublicIngressUrlError,
  normalizePublicIngressUrlType,
  resolvePublicIngressUrl,
} from "./ingress-url.ts";

describe("normalizePublicIngressUrlType", () => {
  test.each([
    [undefined, "subdomain-host"],
    ["", "subdomain-host"],
    ["dunder-prefix", "dunder-prefix"],
    ["subdomain-host", "subdomain-host"],
  ])("normalizes %s -> %s", (input, expected) => {
    expect(normalizePublicIngressUrlType(input)).toBe(expected);
  });

  test("rejects unknown types", () => {
    expect(() => normalizePublicIngressUrlType("path" as never)).toThrowError(
      PublicIngressUrlError,
    );
  });
});

describe("resolvePublicIngressUrl", () => {
  test.each([
    ["", "", "http://events.iterate.localhost", "throw"],
    [
      "bla.proxy.iterate.com",
      "dunder-prefix",
      "http://events.iterate.localhost",
      "https://events__bla.proxy.iterate.com/",
    ],
    [
      "iterate.localhost:12345",
      "subdomain-host",
      "http://events.iterate.localhost",
      "http://events.iterate.localhost:12345/",
    ],
    [
      "bla.proxy.iterate.com",
      "dunder-prefix",
      "events.iterate.localhost",
      "https://events__bla.proxy.iterate.com/",
    ],
    [
      "bla.proxy.iterate.com",
      "dunder-prefix",
      "http://events.iterate.localhost/a/b?x=1#frag",
      "https://events__bla.proxy.iterate.com/a/b?x=1#frag",
    ],
    [
      "bla.proxy.iterate.com",
      "",
      "http://events.iterate.localhost",
      "https://events.bla.proxy.iterate.com/",
    ],
    [
      "bla.proxy.iterate.com",
      "dunder-prefix",
      "http://foo.bar.iterate.localhost",
      "https://foo__bla.proxy.iterate.com/",
    ],
    ["bla.proxy.iterate.com", "dunder-prefix", "http://", "throw"],
    [
      "bla.proxy.iterate.com",
      "dunder-prefix",
      "http://home.iterate.localhost",
      "https://bla.proxy.iterate.com/",
    ],
  ])(
    "baseUrl=%s baseUrlType=%s internalUrl=%s => %s",
    (ingressHost, ingressRoutingType, internalUrl, expected) => {
      if (expected === "throw") {
        expect(() =>
          resolvePublicIngressUrl({
            ingressHost: ingressHost || undefined,
            ingressRoutingType: ingressRoutingType || undefined,
            internalUrl,
          }),
        ).toThrowError(PublicIngressUrlError);
        return;
      }

      expect(
        resolvePublicIngressUrl({
          ingressHost: ingressHost || undefined,
          ingressRoutingType: ingressRoutingType || undefined,
          defaultIngressServiceSlug: "home",
          internalUrl,
        }),
      ).toBe(expected);
    },
  );
});
