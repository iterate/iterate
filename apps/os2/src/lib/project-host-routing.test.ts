import { describe, expect, it } from "vitest";
import {
  buildProjectMcpUrl,
  isReservedProjectHostname,
  isValidCustomHostname,
  normalizeCustomHostname,
  normalizeProjectHostnameBase,
  resolveProjectSlugFromHostname,
} from "./project-host-routing.ts";

describe("project host routing", () => {
  it("resolves one-label project slugs below configured bases", () => {
    expect(resolveProjectSlugFromHostname("alpha.os2.iterate.com", ["os2.iterate.com"])).toBe(
      "alpha",
    );
    expect(
      resolveProjectSlugFromHostname("my-project.os2.iterate.com", ["*.os2.iterate.com"]),
    ).toBe("my-project");
    expect(
      resolveProjectSlugFromHostname("my-project.iterate-preview-3.app", ["iterate-preview-3.app"]),
    ).toBe("my-project");
  });

  it("normalizes case and port suffixes", () => {
    expect(resolveProjectSlugFromHostname("Demo.OS2.Iterate.Com:443", ["os2.iterate.com"])).toBe(
      "demo",
    );
  });

  it("rejects control hosts, nested hosts, and invalid slugs", () => {
    expect(resolveProjectSlugFromHostname("os2.iterate.com", ["os2.iterate.com"])).toBeUndefined();
    expect(
      resolveProjectSlugFromHostname("api.demo.os2.iterate.com", ["os2.iterate.com"]),
    ).toBeUndefined();
    expect(
      resolveProjectSlugFromHostname("bad_slug.os2.iterate.com", ["os2.iterate.com"]),
    ).toBeUndefined();
    expect(
      resolveProjectSlugFromHostname("api.my-project.iterate-preview-3.app", [
        "iterate-preview-3.app",
      ]),
    ).toBeUndefined();
  });

  it("normalizes wildcard route hosts into project hostname bases", () => {
    expect(normalizeProjectHostnameBase("*.os2.iterate.com")).toBe("os2.iterate.com");
  });

  it("normalizes and validates custom hostnames", () => {
    expect(normalizeCustomHostname(" App.Example.Com:443. ")).toBe("app.example.com");
    expect(normalizeCustomHostname(" ")).toBeNull();
    expect(isValidCustomHostname("app.example.com")).toBe(true);
    expect(isValidCustomHostname("localhost")).toBe(false);
    expect(isValidCustomHostname("bad_hostname.example.com")).toBe(false);
  });

  it("detects hostnames reserved for project slug routing", () => {
    expect(isReservedProjectHostname("os2.iterate.com", ["os2.iterate.com"])).toBe(true);
    expect(isReservedProjectHostname("alpha.os2.iterate.com", ["os2.iterate.com"])).toBe(true);
    expect(
      isReservedProjectHostname("alpha.iterate-preview-3.app", ["iterate-preview-3.app"]),
    ).toBe(true);
    expect(isReservedProjectHostname("alpha.example.com", ["os2.iterate.com"])).toBe(false);
  });

  it("builds canonical MCP URLs from the first configured project host base", () => {
    expect(
      buildProjectMcpUrl({
        projectSlug: "demo",
        projectHostnameBases: ["iterate2.app"],
      }),
    ).toBe("https://demo.iterate2.app/mcp");
    expect(
      buildProjectMcpUrl({
        projectSlug: "demo",
        projectHostnameBases: ["*.iterate-preview-3.app"],
      }),
    ).toBe("https://demo.iterate-preview-3.app/mcp");
  });

  it("does not invent MCP URLs without a valid project slug and project host base", () => {
    expect(
      buildProjectMcpUrl({
        projectSlug: "bad_slug",
        projectHostnameBases: ["iterate2.app"],
      }),
    ).toBeNull();
    expect(buildProjectMcpUrl({ projectSlug: "demo", projectHostnameBases: [] })).toBeNull();
    expect(buildProjectMcpUrl({ projectSlug: "demo", projectHostnameBases: ["localhost"] })).toBe(
      null,
    );
  });
});
