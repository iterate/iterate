import { describe, expect, it } from "vitest";
import { cloudflarePreviewSharedPaths } from "./apps.ts";
import { expandPreviewDependencies } from "./preview.ts";

describe("preview app dependency expansion", () => {
  it("adds explicit dependencies for affected apps", () => {
    expect(expandPreviewDependencies(["os2"])).toEqual(["events", "os2"]);
  });

  it("keeps independent apps as-is", () => {
    expect(expandPreviewDependencies(["events"])).toEqual(["events"]);
  });

  it("deduplicates dependencies", () => {
    expect(expandPreviewDependencies(["events", "os2"])).toEqual(["events", "os2"]);
  });
});

describe("preview workflow scope", () => {
  it("includes shared preview orchestration paths", () => {
    expect(cloudflarePreviewSharedPaths).toContain("scripts/preview/**");
    expect(cloudflarePreviewSharedPaths).toContain(
      ".github/ts-workflows/workflows/cloudflare-previews.ts",
    );
    expect(cloudflarePreviewSharedPaths).toContain(".github/workflows/cloudflare-previews.yml");
  });
});
