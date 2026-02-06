import { describe, expect, it } from "vitest";
import {
  hostFromUrl,
  proxyHostForIp,
  urlEncodedForm,
} from "./e2e-node-egress-observability-lib.ts";

describe("e2e helpers", () => {
  it("wraps ipv6 for proxy host", () => {
    expect(proxyHostForIp("fdaa:40:8955:a7b:60c:5f66:cdb9:2")).toBe(
      "[fdaa:40:8955:a7b:60c:5f66:cdb9:2]",
    );
  });

  it("keeps ipv4 untouched", () => {
    expect(proxyHostForIp("10.0.0.7")).toBe("10.0.0.7");
  });

  it("extracts host from URL", () => {
    expect(hostFromUrl("https://example.com/path?q=1")).toBe("example.com");
  });

  it("encodes form body", () => {
    expect(urlEncodedForm({ url: "https://example.com/a b" })).toBe(
      "url=https%3A%2F%2Fexample.com%2Fa+b",
    );
  });
});
