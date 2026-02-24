import { describe, expect, it } from "vitest";
import {
  parseProjectIngressHostname,
  parseCustomDomainHostname,
  isCustomDomainHostname,
  buildMachineIngressEnvVars,
  buildProjectPortUrl,
  buildMachinePortUrl,
  isProjectIngressHostname,
  SERVICE_ALIASES,
} from "./project-ingress.ts";

describe("parseProjectIngressHostname", () => {
  it("parses project slug with default port", () => {
    const result = parseProjectIngressHostname("my-proj.iterate.app");
    expect(result).toEqual({
      ok: true,
      target: { kind: "project", projectSlug: "my-proj", targetPort: 3000, isPortExplicit: false },
      rootDomain: "iterate.app",
    });
  });

  it("parses project slug with explicit port", () => {
    const result = parseProjectIngressHostname("4096__my-proj.iterate.app");
    expect(result).toEqual({
      ok: true,
      target: { kind: "project", projectSlug: "my-proj", targetPort: 4096, isPortExplicit: true },
      rootDomain: "iterate.app",
    });
  });

  it("parses machine ID with default port", () => {
    const result = parseProjectIngressHostname("mach_abc123.iterate.app");
    expect(result).toEqual({
      ok: true,
      target: {
        kind: "machine",
        machineId: "mach_abc123",
        targetPort: 3000,
        isPortExplicit: false,
      },
      rootDomain: "iterate.app",
    });
  });

  it("parses machine ID with explicit port", () => {
    const result = parseProjectIngressHostname("4096__mach_abc123.iterate.app");
    expect(result).toEqual({
      ok: true,
      target: { kind: "machine", machineId: "mach_abc123", targetPort: 4096, isPortExplicit: true },
      rootDomain: "iterate.app",
    });
  });

  it("handles dev tunnel domains", () => {
    const result = parseProjectIngressHostname("my-proj.dev-mmkal-os.dev.iterate.app");
    expect(result).toEqual({
      ok: true,
      target: { kind: "project", projectSlug: "my-proj", targetPort: 3000, isPortExplicit: false },
      rootDomain: "dev-mmkal-os.dev.iterate.app",
    });
  });

  it("rejects too few labels", () => {
    expect(parseProjectIngressHostname("iterate.app")).toEqual({
      ok: false,
      error: "invalid_hostname",
    });
  });

  it("rejects invalid port", () => {
    expect(parseProjectIngressHostname("0__proj.iterate.app")).toEqual({
      ok: false,
      error: "invalid_port",
    });
    expect(parseProjectIngressHostname("abc__proj.iterate.app")).toEqual({
      ok: false,
      error: "invalid_port",
    });
  });

  it("rejects reserved project slugs", () => {
    expect(parseProjectIngressHostname("org.iterate.app")).toEqual({
      ok: false,
      error: "invalid_project_slug",
    });
  });

  it("normalizes to lowercase", () => {
    const result = parseProjectIngressHostname("My-Proj.Iterate.App");
    expect(result).toEqual({
      ok: true,
      target: { kind: "project", projectSlug: "my-proj", targetPort: 3000, isPortExplicit: false },
      rootDomain: "iterate.app",
    });
  });
});

describe("buildMachineIngressEnvVars", () => {
  it("builds env vars for production", () => {
    expect(
      buildMachineIngressEnvVars({
        projectSlug: "my-proj",
        projectIngressDomain: "iterate.app",
        osBaseUrl: "https://os.iterate.com",
        scheme: "https",
      }),
    ).toEqual({
      ITERATE_PROJECT_BASE_URL: "https://my-proj.iterate.app",
      ITERATE_OS_BASE_URL: "https://os.iterate.com",
      ITERATE_PROJECT_INGRESS_DOMAIN: "iterate.app",
    });
  });

  it("builds env vars for dev tunnel", () => {
    expect(
      buildMachineIngressEnvVars({
        projectSlug: "my-proj",
        projectIngressDomain: "dev-mmkal-os.dev.iterate.app",
        osBaseUrl: "https://dev-mmkal-os.dev.iterate.com",
        scheme: "https",
      }),
    ).toEqual({
      ITERATE_PROJECT_BASE_URL: "https://my-proj.dev-mmkal-os.dev.iterate.app",
      ITERATE_OS_BASE_URL: "https://dev-mmkal-os.dev.iterate.com",
      ITERATE_PROJECT_INGRESS_DOMAIN: "dev-mmkal-os.dev.iterate.app",
    });
  });
});

describe("buildProjectPortUrl", () => {
  it("default port 3000 omits prefix", () => {
    expect(buildProjectPortUrl({ projectBaseUrl: "https://my-proj.iterate.app", port: 3000 })).toBe(
      "https://my-proj.iterate.app/",
    );
  });

  it("non-default port prefixes hostname", () => {
    expect(buildProjectPortUrl({ projectBaseUrl: "https://my-proj.iterate.app", port: 4096 })).toBe(
      "https://4096__my-proj.iterate.app/",
    );
  });

  it("includes path", () => {
    expect(
      buildProjectPortUrl({
        projectBaseUrl: "https://my-proj.iterate.app",
        port: 4096,
        path: "/foo/bar",
      }),
    ).toBe("https://4096__my-proj.iterate.app/foo/bar");
  });

  it("normalizes path without leading slash", () => {
    expect(
      buildProjectPortUrl({
        projectBaseUrl: "https://my-proj.iterate.app",
        port: 4096,
        path: "foo",
      }),
    ).toBe("https://4096__my-proj.iterate.app/foo");
  });
});

describe("buildMachinePortUrl", () => {
  it("builds machine URL with explicit port", () => {
    expect(
      buildMachinePortUrl({
        scheme: "https",
        projectIngressDomain: "iterate.app",
        machineId: "mach_123",
        port: 4096,
      }),
    ).toBe("https://4096__mach_123.iterate.app/");
  });

  it("default port 3000 omits prefix", () => {
    expect(
      buildMachinePortUrl({
        scheme: "https",
        projectIngressDomain: "iterate.app",
        machineId: "mach_123",
        port: 3000,
      }),
    ).toBe("https://mach_123.iterate.app/");
  });

  it("includes path", () => {
    expect(
      buildMachinePortUrl({
        scheme: "https",
        projectIngressDomain: "iterate.app",
        machineId: "mach_123",
        port: 16686,
        path: "/trace/abc",
      }),
    ).toBe("https://16686__mach_123.iterate.app/trace/abc");
  });
});

describe("isProjectIngressHostname", () => {
  it("matches subdomain of ingress domain", () => {
    expect(isProjectIngressHostname("my-proj.iterate.app", "iterate.app")).toBe(true);
    expect(isProjectIngressHostname("4096__mach_123.iterate.app", "iterate.app")).toBe(true);
  });

  it("matches nested subdomain", () => {
    expect(
      isProjectIngressHostname(
        "my-proj.dev-mmkal-os.dev.iterate.app",
        "dev-mmkal-os.dev.iterate.app",
      ),
    ).toBe(true);
  });

  it("rejects the domain itself (no subdomain)", () => {
    expect(isProjectIngressHostname("iterate.app", "iterate.app")).toBe(false);
  });

  it("rejects unrelated domains", () => {
    expect(isProjectIngressHostname("my-proj.example.com", "iterate.app")).toBe(false);
  });

  it("case insensitive", () => {
    expect(isProjectIngressHostname("My-Proj.Iterate.App", "iterate.app")).toBe(true);
  });
});

describe("parseCustomDomainHostname", () => {
  it("exact match → project, default port", () => {
    const result = parseCustomDomainHostname("templestein.com", "templestein.com");
    expect(result).toEqual({ ok: true, target: { kind: "project", targetPort: 3000 } });
  });

  it("numeric subdomain → project, explicit port", () => {
    const result = parseCustomDomainHostname("4096.templestein.com", "templestein.com");
    expect(result).toEqual({ ok: true, target: { kind: "project", targetPort: 4096 } });
  });

  it("service alias → project, aliased port", () => {
    const result = parseCustomDomainHostname("opencode.templestein.com", "templestein.com");
    expect(result).toEqual({
      ok: true,
      target: { kind: "project", targetPort: SERVICE_ALIASES.opencode },
    });
  });

  it("terminal alias → project, aliased port", () => {
    const result = parseCustomDomainHostname("terminal.templestein.com", "templestein.com");
    expect(result).toEqual({
      ok: true,
      target: { kind: "project", targetPort: SERVICE_ALIASES.terminal },
    });
  });

  it("machine with port → machine target", () => {
    const result = parseCustomDomainHostname(
      "4096__mach_abc123.templestein.com",
      "templestein.com",
    );
    expect(result).toEqual({
      ok: true,
      target: { kind: "machine", machineId: "mach_abc123", targetPort: 4096 },
    });
  });

  it("machine without port → machine target, default port", () => {
    const result = parseCustomDomainHostname("mach_abc123.templestein.com", "templestein.com");
    expect(result).toEqual({
      ok: true,
      target: { kind: "machine", machineId: "mach_abc123", targetPort: 3000 },
    });
  });

  it("subdomain custom domain — exact match", () => {
    const result = parseCustomDomainHostname("iterate.templestein.com", "iterate.templestein.com");
    expect(result).toEqual({ ok: true, target: { kind: "project", targetPort: 3000 } });
  });

  it("subdomain custom domain — port subdomain", () => {
    const result = parseCustomDomainHostname(
      "4096.iterate.templestein.com",
      "iterate.templestein.com",
    );
    expect(result).toEqual({ ok: true, target: { kind: "project", targetPort: 4096 } });
  });

  it("not_custom_domain for unrelated hostname", () => {
    const result = parseCustomDomainHostname("example.com", "templestein.com");
    expect(result).toEqual({ ok: false, error: "not_custom_domain" });
  });

  it("invalid_subdomain for nested subdomains", () => {
    const result = parseCustomDomainHostname("a.b.templestein.com", "templestein.com");
    expect(result).toEqual({ ok: false, error: "invalid_subdomain" });
  });

  it("case insensitive", () => {
    const result = parseCustomDomainHostname("OpenCode.Templestein.COM", "templestein.com");
    expect(result).toEqual({
      ok: true,
      target: { kind: "project", targetPort: SERVICE_ALIASES.opencode },
    });
  });
});

describe("isCustomDomainHostname", () => {
  it("matches exact domain", () => {
    expect(isCustomDomainHostname("templestein.com", "templestein.com")).toBe(true);
  });

  it("matches subdomain", () => {
    expect(isCustomDomainHostname("4096.templestein.com", "templestein.com")).toBe(true);
  });

  it("rejects unrelated domain", () => {
    expect(isCustomDomainHostname("example.com", "templestein.com")).toBe(false);
  });

  it("case insensitive", () => {
    expect(isCustomDomainHostname("Templestein.COM", "templestein.com")).toBe(true);
  });
});

describe("buildMachineIngressEnvVars with customDomain", () => {
  it("uses custom domain when set", () => {
    const result = buildMachineIngressEnvVars({
      projectSlug: "my-proj",
      projectIngressDomain: "iterate.app",
      osBaseUrl: "https://os.iterate.com",
      scheme: "https",
      customDomain: "templestein.com",
    });
    expect(result).toEqual({
      ITERATE_PROJECT_BASE_URL: "https://templestein.com",
      ITERATE_OS_BASE_URL: "https://os.iterate.com",
      ITERATE_PROJECT_INGRESS_DOMAIN: "templestein.com",
    });
  });

  it("uses default when customDomain is null", () => {
    const result = buildMachineIngressEnvVars({
      projectSlug: "my-proj",
      projectIngressDomain: "iterate.app",
      osBaseUrl: "https://os.iterate.com",
      scheme: "https",
      customDomain: null,
    });
    expect(result).toEqual({
      ITERATE_PROJECT_BASE_URL: "https://my-proj.iterate.app",
      ITERATE_OS_BASE_URL: "https://os.iterate.com",
      ITERATE_PROJECT_INGRESS_DOMAIN: "iterate.app",
    });
  });
});
