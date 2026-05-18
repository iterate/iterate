import { describe, expect, it } from "vitest";
import {
  buildProjectWorkerUrl,
  buildProjectMcpUrl,
  isReservedProjectHostname,
  isValidCustomHostname,
  normalizeCustomHostname,
  normalizeProjectHostnameBase,
  resolveProjectSlugFromHostname,
} from "./project-host-routing.ts";

describe("project host routing", () => {
  it("resolves one-label project slugs below configured bases", () => {
    expect(resolveProjectSlugFromHostname("alpha.os.iterate.com", ["os.iterate.com"])).toBe(
      "alpha",
    );
    expect(resolveProjectSlugFromHostname("my-project.os.iterate.com", ["*.os.iterate.com"])).toBe(
      "my-project",
    );
    expect(
      resolveProjectSlugFromHostname("my-project.iterate-preview-3.app", ["iterate-preview-3.app"]),
    ).toBe("my-project");
  });

  it("normalizes case and port suffixes", () => {
    expect(resolveProjectSlugFromHostname("Demo.OS.Iterate.Com:443", ["os.iterate.com"])).toBe(
      "demo",
    );
  });

  it("rejects control hosts, nested hosts, and invalid slugs", () => {
    expect(resolveProjectSlugFromHostname("os.iterate.com", ["os.iterate.com"])).toBeUndefined();
    expect(
      resolveProjectSlugFromHostname("api.demo.os.iterate.com", ["os.iterate.com"]),
    ).toBeUndefined();
    expect(
      resolveProjectSlugFromHostname("bad_slug.os.iterate.com", ["os.iterate.com"]),
    ).toBeUndefined();
    expect(
      resolveProjectSlugFromHostname("api.my-project.iterate-preview-3.app", [
        "iterate-preview-3.app",
      ]),
    ).toBeUndefined();
  });

  it("normalizes wildcard route hosts into project hostname bases", () => {
    expect(normalizeProjectHostnameBase("*.os.iterate.com")).toBe("os.iterate.com");
  });

  it("normalizes and validates custom hostnames", () => {
    expect(normalizeCustomHostname(" App.Example.Com:443. ")).toBe("app.example.com");
    expect(normalizeCustomHostname(" ")).toBeNull();
    expect(isValidCustomHostname("app.example.com")).toBe(true);
    expect(isValidCustomHostname("localhost")).toBe(false);
    expect(isValidCustomHostname("bad_hostname.example.com")).toBe(false);
  });

  it("detects hostnames reserved for project slug routing", () => {
    expect(isReservedProjectHostname("os.iterate.com", ["os.iterate.com"])).toBe(true);
    expect(isReservedProjectHostname("alpha.os.iterate.com", ["os.iterate.com"])).toBe(true);
    expect(
      isReservedProjectHostname("alpha.iterate-preview-3.app", ["iterate-preview-3.app"]),
    ).toBe(true);
    expect(isReservedProjectHostname("alpha.example.com", ["os.iterate.com"])).toBe(false);
  });

  it("builds canonical MCP URLs from the first configured project host base", () => {
    expect(
      buildProjectMcpUrl({
        projectSlug: "demo",
        projectHostnameBases: ["iterate.app"],
      }),
    ).toBe("https://mcp__demo.iterate.app");
    expect(
      buildProjectMcpUrl({
        projectSlug: "demo",
        projectHostnameBases: ["*.iterate-preview-3.app"],
      }),
    ).toBe("https://mcp__demo.iterate-preview-3.app");
  });

  it("prefers custom hostnames for MCP URLs", () => {
    expect(
      buildProjectMcpUrl({
        projectSlug: "demo",
        customHostname: "mcp-demo.iterate.app",
        projectHostnameBases: ["os-mcp.iterate.app"],
      }),
    ).toBe("https://mcp-demo.iterate.app");
  });

  it("does not invent MCP URLs without a valid project slug and project host base", () => {
    expect(
      buildProjectMcpUrl({
        projectSlug: "bad_slug",
        projectHostnameBases: ["iterate.app"],
      }),
    ).toBeNull();
    expect(buildProjectMcpUrl({ projectSlug: "demo", projectHostnameBases: [] })).toBeNull();
    expect(buildProjectMcpUrl({ projectSlug: "demo", projectHostnameBases: ["localhost"] })).toBe(
      null,
    );
  });
});

describe("buildProjectWorkerUrl", () => {
  it("builds the canonical project worker URL", () => {
    expect(
      buildProjectWorkerUrl({
        projectSlug: "demo",
        projectHostnameBases: ["iterate.app"],
      }),
    ).toBe("https://demo.iterate.app");
  });

  it("prefers a custom hostname", () => {
    expect(
      buildProjectWorkerUrl({
        customHostname: "demo.example.com",
        projectSlug: "demo",
        projectHostnameBases: ["iterate.app"],
      }),
    ).toBe("https://demo.example.com");
  });
});
