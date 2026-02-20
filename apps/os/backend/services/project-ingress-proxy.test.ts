import { describe, expect, it } from "vitest";
import {
  getProjectIngressRequestHostname,
  parseProjectIngressProxyHostMatchers,
  resolveIngressHostname,
  shouldHandleProjectIngressHostname,
} from "./project-ingress-proxy.ts";

describe("project ingress hostname matching", () => {
  const hostMatchers = parseProjectIngressProxyHostMatchers("*.*.dev.iterate.com,*.iterate.app");

  it("matches project slug host under iterate.app", () => {
    expect(shouldHandleProjectIngressHostname("misha.iterate.app", hostMatchers)).toBe(true);
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

  it("matches machine id host under iterate.app", () => {
    expect(shouldHandleProjectIngressHostname("mach_123.iterate.app", hostMatchers)).toBe(true);
  });

  it("does not match unrelated hostnames", () => {
    expect(shouldHandleProjectIngressHostname("google.com", hostMatchers)).toBe(false);
  });

  it("does not match unrelated hostnames", () => {
    expect(shouldHandleProjectIngressHostname("misha.example.com", hostMatchers)).toBe(false);
  });
});

describe("project ingress hostname resolution", () => {
  it("resolves project slug host with explicit port prefix", () => {
    expect(resolveIngressHostname("4096__banana.dev-jonas-os.dev.iterate.com")).toEqual({
      ok: true,
      target: { kind: "project", projectSlug: "banana", targetPort: 4096, isPortExplicit: true },
      rootDomain: "dev-jonas-os.dev.iterate.com",
    });
  });

  it("rejects invalid project slug tokens", () => {
    expect(resolveIngressHostname("1234.dev-jonas-os.dev.iterate.com")).toEqual({
      ok: false,
      error: "invalid_project_slug",
    });
  });
});

describe("project ingress request hostname", () => {
  it("prefers host header when request url host is localhost", () => {
    const request = new Request("http://localhost/api/pty/ws", {
      headers: {
        host: "3000__mach_01kh7nrrtkfap865vjbmv559ta.jonas2.dev.iterate.com",
      },
    });

    expect(getProjectIngressRequestHostname(request)).toBe(
      "3000__mach_01kh7nrrtkfap865vjbmv559ta.jonas2.dev.iterate.com",
    );
  });

  it("prefers x-forwarded-host over host", () => {
    const request = new Request("http://localhost/", {
      headers: {
        host: "localhost:5173",
        "x-forwarded-host": "4096__mach_abc.dev.iterate.com",
      },
    });

    expect(getProjectIngressRequestHostname(request)).toBe("4096__mach_abc.dev.iterate.com");
  });
});
