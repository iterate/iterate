import { describe, expect, it } from "vitest";
import {
  parseProjectIngressProxyHostMatchers,
  shouldHandleProjectIngressHostname,
} from "./project-ingress-proxy.ts";

describe("project ingress hostname matching", () => {
  const hostMatchers = parseProjectIngressProxyHostMatchers(
    "*.local.iterate.town,*.machines.local.iterate.town,*.*.dev.iterate.com,*.iterate.town,*.machines.iterate.town,*.iterate.app,*.machines.iterate.app",
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

  it("matches machine host under nested dev subdomain", () => {
    expect(
      shouldHandleProjectIngressHostname("mach_123.machines.jonas.dev.iterate.com", hostMatchers),
    ).toBe(true);
  });

  it("matches machine host under machines root", () => {
    expect(shouldHandleProjectIngressHostname("mach_123.machines.iterate.town", hostMatchers)).toBe(
      true,
    );
  });

  it("does not match unrelated hostnames", () => {
    expect(shouldHandleProjectIngressHostname("google.com", hostMatchers)).toBe(false);
  });
});
