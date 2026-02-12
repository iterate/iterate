import { describe, expect, it } from "vitest";
import {
  buildCanonicalMachineIngressUrl,
  getIngressSchemeFromPublicUrl,
  isCanonicalIngressHostCoveredByMatchers,
  normalizeProjectIngressCanonicalHost,
} from "./project-ingress-url.ts";

describe("normalizeProjectIngressCanonicalHost", () => {
  it("normalizes valid hostnames", () => {
    expect(normalizeProjectIngressCanonicalHost("P.OS.ITERATE.COM")).toBe("p.os.iterate.com");
  });

  it("rejects invalid hostnames", () => {
    expect(normalizeProjectIngressCanonicalHost("")).toBeNull();
    expect(normalizeProjectIngressCanonicalHost("*.p.os.iterate.com")).toBeNull();
    expect(normalizeProjectIngressCanonicalHost("https://p.os.iterate.com")).toBeNull();
    expect(normalizeProjectIngressCanonicalHost("p.os.iterate.com:443")).toBeNull();
    expect(normalizeProjectIngressCanonicalHost("p.os.iterate.com/path")).toBeNull();
  });
});

describe("isCanonicalIngressHostCoveredByMatchers", () => {
  it("accepts canonical host covered by wildcard matcher", () => {
    expect(
      isCanonicalIngressHostCoveredByMatchers({
        canonicalHost: "p.os.iterate.com",
        hostMatchers: ["*.p.os.iterate.com"],
      }),
    ).toBe(true);
  });

  it("rejects canonical host not covered by matcher", () => {
    expect(
      isCanonicalIngressHostCoveredByMatchers({
        canonicalHost: "jonas.dev.iterate.com",
        hostMatchers: ["*.p.os.iterate.com"],
      }),
    ).toBe(false);
  });
});

describe("buildCanonicalMachineIngressUrl", () => {
  it("builds canonical machine ingress URL", () => {
    expect(
      buildCanonicalMachineIngressUrl({
        scheme: "https",
        canonicalHost: "p.os.iterate.com",
        machineId: "mach_123",
        port: 4096,
      }),
    ).toBe("https://4096__mach_123.p.os.iterate.com/");
  });
});

describe("getIngressSchemeFromPublicUrl", () => {
  it("extracts HTTP/S scheme", () => {
    expect(getIngressSchemeFromPublicUrl("https://os.iterate.com")).toBe("https");
    expect(getIngressSchemeFromPublicUrl("http://localhost:5173")).toBe("http");
  });
});
