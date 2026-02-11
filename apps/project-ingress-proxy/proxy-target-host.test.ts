import { describe, expect, it } from "vitest";
import { parseProxyTargetHost } from "./proxy-target-host.ts";

describe("parseProxyTargetHost", () => {
  it("maps a prefixed port to localhost", () => {
    const target = parseProxyTargetHost("4096__bla.bla.com");
    expect(target).toEqual({
      upstreamHost: "localhost",
      upstreamPort: 4096,
      upstreamHostHeader: "localhost:4096",
      upstreamOrigin: "http://localhost:4096",
    });
  });

  it("uses default port when no prefix is provided", () => {
    const target = parseProxyTargetHost("banana.boopie.lala.internal");
    expect(target).toEqual({
      upstreamHost: "localhost",
      upstreamPort: 3000,
      upstreamHostHeader: "localhost:3000",
      upstreamOrigin: "http://localhost:3000",
    });
  });

  it("rejects out-of-range prefixed ports", () => {
    expect(parseProxyTargetHost("70000__banana.boopie.lala.internal")).toBeNull();
    expect(parseProxyTargetHost("0__banana.boopie.lala.internal")).toBeNull();
  });

  it("rejects empty host segment after numeric prefix", () => {
    expect(parseProxyTargetHost("4096__")).toBeNull();
  });
});
