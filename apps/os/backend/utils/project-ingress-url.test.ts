import { describe, expect, it } from "vitest";
import {
  getIngressSchemeFromPublicUrl,
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

describe("getIngressSchemeFromPublicUrl", () => {
  it("extracts HTTP/S scheme", () => {
    expect(getIngressSchemeFromPublicUrl("https://os.iterate.com")).toBe("https");
    expect(getIngressSchemeFromPublicUrl("http://localhost:5173")).toBe("http");
  });
});
