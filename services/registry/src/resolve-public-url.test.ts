import { describe, expect, test } from "vitest";
import { ResolvePublicUrlError, resolvePublicUrl } from "./resolve-public-url.ts";

describe("resolvePublicUrl", () => {
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
          ITERATE_INGRESS_DEFAULT_SERVICE: "home",
          internalURL,
        }),
      ).toBe(expected);
    },
  );
});
