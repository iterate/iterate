import { describe, expect, test } from "vitest";
import { ResolvePublicUrlError, resolvePublicUrl } from "./resolve-public-url.ts";

describe("resolvePublicUrl", () => {
  test.each([
    ["", "", "http://events.iterate.localhost", "throw"],
    [
      "https://bla.proxy.iterate.com",
      "prefix",
      "http://events.iterate.localhost",
      "https://events__bla.proxy.iterate.com/",
    ],
    [
      "http://iterate.localhost:12345",
      "subdomain",
      "http://events.iterate.localhost",
      "http://events.iterate.localhost:12345/",
    ],
    [
      "https://bla.proxy.iterate.com",
      "prefix",
      "events.iterate.localhost",
      "https://events__bla.proxy.iterate.com/",
    ],
    [
      "https://bla.proxy.iterate.com",
      "prefix",
      "http://events.iterate.localhost/a/b?x=1#frag",
      "https://events__bla.proxy.iterate.com/a/b?x=1#frag",
    ],
    [
      "https://bla.proxy.iterate.com",
      "",
      "http://events.iterate.localhost",
      "https://events__bla.proxy.iterate.com/",
    ],
    [
      "https://bla.proxy.iterate.com",
      "prefix",
      "http://foo.bar.iterate.localhost",
      "https://foo__bla.proxy.iterate.com/",
    ],
    ["https://bla.proxy.iterate.com", "prefix", "http://", "throw"],
  ])(
    "baseUrl=%s baseUrlType=%s internalURL=%s => %s",
    (baseUrl, baseUrlType, internalURL, expected) => {
      if (expected === "throw") {
        expect(() =>
          resolvePublicUrl({
            ITERATE_PUBLIC_BASE_URL: baseUrl || undefined,
            ITERATE_PUBLIC_BASE_URL_TYPE:
              baseUrlType === "prefix" || baseUrlType === "subdomain" ? baseUrlType : undefined,
            internalURL,
          }),
        ).toThrowError(ResolvePublicUrlError);
        return;
      }

      expect(
        resolvePublicUrl({
          ITERATE_PUBLIC_BASE_URL: baseUrl || undefined,
          ITERATE_PUBLIC_BASE_URL_TYPE:
            baseUrlType === "prefix" || baseUrlType === "subdomain" ? baseUrlType : undefined,
          internalURL,
        }),
      ).toBe(expected);
    },
  );
});
