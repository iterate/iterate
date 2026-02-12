import { describe, expect, it } from "vitest";
import {
  parseProjectIngressProxyHostMatchers,
  resolveIngressHostname,
  shouldHandleProjectIngressHostname,
} from "./project-ingress-proxy.ts";

describe("project ingress hostname matching", () => {
  const hostMatchers = parseProjectIngressProxyHostMatchers(
    "*.local.iterate.town,*.*.dev.iterate.com,*.iterate.town,*.iterate.app",
  );

  it("matches project slug host under iterate.town", () => {
    expect(shouldHandleProjectIngressHostname("misha.iterate.town", hostMatchers)).toBe(true);
  });

  it("matches nested dev subdomain host", () => {
    expect(shouldHandleProjectIngressHostname("misha.jonas.dev.iterate.com", hostMatchers)).toBe(
      true,
    );
  });

  it("does not match base dev environment host", () => {
    expect(shouldHandleProjectIngressHostname("jonas.dev.iterate.com", hostMatchers)).toBe(false);
  });

  it("matches machine id host under nested dev subdomain", () => {
    expect(shouldHandleProjectIngressHostname("mach_123.jonas.dev.iterate.com", hostMatchers)).toBe(
      true,
    );
  });

  it("matches machine id host under iterate.town", () => {
    expect(shouldHandleProjectIngressHostname("mach_123.iterate.town", hostMatchers)).toBe(true);
  });

  it("does not match unrelated hostnames", () => {
    expect(shouldHandleProjectIngressHostname("google.com", hostMatchers)).toBe(false);
  });
});

describe("project ingress hostname resolution", () => {
  it("resolves project slug host with explicit port prefix", () => {
    expect(resolveIngressHostname("4096__banana.dev-jonas-os.dev.iterate.com")).toEqual({
      ok: true,
      target: { kind: "project", projectSlug: "banana", targetPort: 4096 },
      rootDomain: "dev-jonas-os.dev.iterate.com",
    });
  });

  it("rejects invalid project slug tokens", () => {
    expect(resolveIngressHostname("banana_test.dev-jonas-os.dev.iterate.com")).toEqual({
      ok: false,
      error: "invalid_project_slug",
    });
  });
});
