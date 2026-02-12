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

  it("accepts explicit localhost:port target", () => {
    const target = parseProxyTargetHost("localhost:4096");
    expect(target).toEqual({
      upstreamHost: "localhost",
      upstreamPort: 4096,
      upstreamHostHeader: "localhost:4096",
      upstreamOrigin: "http://localhost:4096",
    });
  });

  it("accepts explicit 127.0.0.1:port target", () => {
    const target = parseProxyTargetHost("127.0.0.1:3001");
    expect(target).toEqual({
      upstreamHost: "localhost",
      upstreamPort: 3001,
      upstreamHostHeader: "localhost:3001",
      upstreamOrigin: "http://localhost:3001",
    });
  });

  it("rejects explicit non-local host:port target", () => {
    expect(parseProxyTargetHost("example.com:4096")).toBeNull();
  });
});
