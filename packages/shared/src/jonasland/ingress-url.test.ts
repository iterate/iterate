import { describe, expect, test } from "vitest";
import {
  PublicIngressUrlError,
  normalizePublicIngressUrlType,
  resolvePublicIngressUrl,
} from "./ingress-url.ts";

describe("normalizePublicIngressUrlType", () => {
  test.each([
    [undefined, "prefix"],
    ["", "prefix"],
    ["prefix", "prefix"],
    ["subdomain", "subdomain"],
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
    "baseUrl=%s baseUrlType=%s internalUrl=%s => %s",
    (publicBaseUrl, publicBaseUrlType, internalUrl, expected) => {
      if (expected === "throw") {
        expect(() =>
          resolvePublicIngressUrl({
            publicBaseUrl: publicBaseUrl || undefined,
            publicBaseUrlType: publicBaseUrlType || undefined,
            internalUrl,
          }),
        ).toThrowError(PublicIngressUrlError);
        return;
      }

      expect(
        resolvePublicIngressUrl({
          publicBaseUrl: publicBaseUrl || undefined,
          publicBaseUrlType: publicBaseUrlType || undefined,
          internalUrl,
        }),
      ).toBe(expected);
    },
  );
});
