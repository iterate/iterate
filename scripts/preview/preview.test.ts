import { describe, expect, it } from "vitest";
import { cloudflarePreviewSharedPaths } from "./apps.ts";
import { expandPreviewDependencies, resolvePreviewCompareBaseSha } from "./preview.ts";

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

describe("preview compare base", () => {
  it("uses the pull request base before any app has deployed", () => {
    expect(
      resolvePreviewCompareBaseSha({
        previousState: {
          apps: {},
          environmentConfigLease: null,
        },
        pullRequestBaseSha: "base-sha",
      }),
    ).toBe("base-sha");
  });

  it("uses the previously deployed app commit after preview state exists", () => {
    expect(
      resolvePreviewCompareBaseSha({
        previousState: {
          apps: {
            os2: {
              appDisplayName: "OS",
              appSlug: "os2",
              headSha: "previous-preview-sha",
              status: "deployed",
              updatedAt: "2026-05-01T00:00:00.000Z",
            },
          },
          environmentConfigLease: null,
        },
        pullRequestBaseSha: "base-sha",
      }),
    ).toBe("previous-preview-sha");
  });
});
