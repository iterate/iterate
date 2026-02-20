import { describe, expect, it } from "vitest";
import {
  buildCanonicalMachineIngressUrl,
  getIngressSchemeFromPublicUrl,
  isCanonicalIngressHostCoveredByMatchers,
  normalizeProjectIngressCanonicalHost,
} from "./project-ingress-url.ts";

describe("normalizeProjectIngressCanonicalHost", () => {
  it("normalizes valid hostnames", () => {
    expect(normalizeProjectIngressCanonicalHost("OS.ITERATE.COM")).toBe("os.iterate.com");
  });

  it("rejects invalid hostnames", () => {
    expect(normalizeProjectIngressCanonicalHost("")).toBeNull();
    expect(normalizeProjectIngressCanonicalHost("*.os.iterate.com")).toBeNull();
    expect(normalizeProjectIngressCanonicalHost("https://os.iterate.com")).toBeNull();
    expect(normalizeProjectIngressCanonicalHost("os.iterate.com:443")).toBeNull();
    expect(normalizeProjectIngressCanonicalHost("os.iterate.com/path")).toBeNull();
  });
});

describe("isCanonicalIngressHostCoveredByMatchers", () => {
  it("accepts canonical host covered by wildcard matcher", () => {
    expect(
      isCanonicalIngressHostCoveredByMatchers({
        canonicalHost: "dev-rahul-os.dev.iterate.com",
        hostMatchers: ["*.*.dev.iterate.com", "*.iterate.app"],
      }),
    ).toBe(true);
  });

  it("rejects canonical host not covered by matcher", () => {
    expect(
      isCanonicalIngressHostCoveredByMatchers({
        canonicalHost: "os.iterate.com",
        hostMatchers: ["*.iterate.app"],
      }),
    ).toBe(false);
  });
});

describe("buildCanonicalMachineIngressUrl", () => {
  it("builds canonical machine ingress URL", () => {
    expect(
      buildCanonicalMachineIngressUrl({
        scheme: "https",
        canonicalHost: "iterate.app",
        machineId: "mach_123",
        port: 4096,
      }),
    ).toBe("https://4096__mach_123.iterate.app/");
  });
});

describe("getIngressSchemeFromPublicUrl", () => {
  it("extracts HTTP/S scheme", () => {
    expect(getIngressSchemeFromPublicUrl("https://os.iterate.com")).toBe("https");
    expect(getIngressSchemeFromPublicUrl("http://localhost:5173")).toBe("http");
  });
});
