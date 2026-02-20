import { describe, expect, it } from "vitest";
import {
  parseProjectIngressHostname,
  isProjectIngressHostname,
} from "@iterate-com/shared/project-ingress";
import { getProjectIngressRequestHostname } from "./project-ingress-proxy.ts";

describe("project ingress hostname matching", () => {
  it("matches project slug host under iterate.app", () => {
    expect(isProjectIngressHostname("misha.iterate.app", "iterate.app")).toBe(true);
  });

  it("matches nested dev subdomain host", () => {
    expect(isProjectIngressHostname("misha.jonas.dev.iterate.app", "jonas.dev.iterate.app")).toBe(
      true,
    );
  });

  it("does not match the ingress domain itself", () => {
    expect(isProjectIngressHostname("iterate.app", "iterate.app")).toBe(false);
  });

  it("matches machine id host under iterate.app", () => {
    expect(isProjectIngressHostname("mach_123.iterate.app", "iterate.app")).toBe(true);
  });

  it("does not match unrelated hostnames", () => {
    expect(isProjectIngressHostname("google.com", "iterate.app")).toBe(false);
  });

  it("does not match unrelated hostnames with subdomain", () => {
    expect(isProjectIngressHostname("misha.example.com", "iterate.app")).toBe(false);
  });
});

describe("project ingress hostname resolution", () => {
  it("resolves project slug host with explicit port prefix", () => {
    expect(parseProjectIngressHostname("4096__banana.dev-jonas-os.dev.iterate.com")).toEqual({
      ok: true,
      target: { kind: "project", projectSlug: "banana", targetPort: 4096, isPortExplicit: true },
      rootDomain: "dev-jonas-os.dev.iterate.com",
    });
  });

  it("rejects invalid project slug tokens", () => {
    expect(parseProjectIngressHostname("1234.dev-jonas-os.dev.iterate.com")).toEqual({
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
