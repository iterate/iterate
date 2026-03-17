import { describe, expect, test } from "vitest";
import { ResolvePublicUrlError, resolvePublicUrl } from "./resolve-public-url.ts";

describe("resolvePublicUrl", () => {
  test.each([
    ["", "", "http://example.iterate.localhost", "throw"],
    [
      "bla.proxy.iterate.com",
      "dunder-prefix",
      "http://example.iterate.localhost",
      "https://example__bla.proxy.iterate.com/",
    ],
    [
      "iterate.localhost:12345",
      "subdomain-host",
      "http://example.iterate.localhost",
      "http://example.iterate.localhost:12345/",
    ],
    [
      "bla.proxy.iterate.com",
      "dunder-prefix",
      "example.iterate.localhost",
      "https://example__bla.proxy.iterate.com/",
    ],
    [
      "bla.proxy.iterate.com",
      "dunder-prefix",
      "http://example.iterate.localhost/a/b?x=1#frag",
      "https://example__bla.proxy.iterate.com/a/b?x=1#frag",
    ],
    [
      "bla.proxy.iterate.com",
      "",
      "http://example.iterate.localhost",
      "https://example.bla.proxy.iterate.com/",
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
      "http://registry.iterate.localhost",
      "https://bla.proxy.iterate.com/",
    ],
  ])(
    "baseUrl=%s baseUrlType=%s internalURL=%s => %s",
    (baseUrl, baseUrlType, internalURL, expected) => {
      if (expected === "throw") {
        expect(() =>
          resolvePublicUrl({
            ITERATE_INGRESS_HOST: baseUrl || undefined,
            ITERATE_INGRESS_ROUTING_TYPE:
              baseUrlType === "dunder-prefix" || baseUrlType === "subdomain-host"
                ? baseUrlType
                : undefined,
            internalURL,
          }),
        ).toThrowError(ResolvePublicUrlError);
        return;
      }

      expect(
        resolvePublicUrl({
          ITERATE_INGRESS_HOST: baseUrl || undefined,
          ITERATE_INGRESS_ROUTING_TYPE:
            baseUrlType === "dunder-prefix" || baseUrlType === "subdomain-host"
              ? baseUrlType
              : undefined,
          ITERATE_INGRESS_DEFAULT_SERVICE: "registry",
          internalURL,
        }),
      ).toBe(expected);
    },
  );
});
