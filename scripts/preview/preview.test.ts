import { describe, expect, it } from "vitest";
import {
  cloudflarePreviewApps,
  cloudflarePreviewAdditionalTriggerPaths,
  cloudflarePreviewSharedPaths,
} from "./apps.ts";
import {
  batchPreviewAppsByDependencies,
  expandPreviewDependencies,
  resolvePreviewReadinessUrls,
  resolvePreviewCompareBaseSha,
  selectPreviewAppsNeedingRetry,
} from "./preview.ts";

describe("preview app dependency expansion", () => {
  it("expands os to include its auth dependency", () => {
    expect(expandPreviewDependencies(["os"])).toEqual(["os", "auth"]);
  });

  it("keeps independent apps as-is", () => {
    expect(expandPreviewDependencies(["semaphore"])).toEqual(["semaphore"]);
  });

  it("deduplicates dependencies", () => {
    expect(expandPreviewDependencies(["os", "os", "auth"])).toEqual(["os", "auth"]);
  });
});

describe("preview app dependency batches", () => {
  it("keeps independent apps in the same batch", () => {
    expect(
      batchPreviewAppsByDependencies([
        cloudflarePreviewApps.os,
        cloudflarePreviewApps.semaphore,
      ]).map((batch) => batch.map((app) => app.slug)),
    ).toEqual([["os", "semaphore"]]);
  });
});

describe("preview workflow scope", () => {
  it("includes shared preview orchestration paths", () => {
    expect(cloudflarePreviewSharedPaths).toContain("scripts/preview/**");
    expect(cloudflarePreviewSharedPaths).toContain("packages/ui/**");
    expect(cloudflarePreviewAdditionalTriggerPaths).toContain("apps/iterate-com/**");
    expect(cloudflarePreviewSharedPaths).toContain(
      ".github/ts-workflows/workflows/cloudflare-previews.ts",
    );
    expect(cloudflarePreviewSharedPaths).toContain(".github/workflows/cloudflare-previews.yml");
  });
});

describe("preview readiness URLs", () => {
  it("checks the deployed app URL without probing synthetic project hostnames", () => {
    expect(
      resolvePreviewReadinessUrls({
        publicUrl: "https://os.iterate-preview-2.com",
        projectHostnameBases: ["iterate-preview-2.app", "*.iterate-preview-2.app"],
      }).map((url) => url.toString()),
    ).toEqual(["https://os.iterate-preview-2.com/api/__internal/health"]);
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
            os: {
              appDisplayName: "OS",
              appSlug: "os",
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

describe("preview retry selection", () => {
  it("retries current-head failed apps and their dependencies", () => {
    expect(
      selectPreviewAppsNeedingRetry({
        previousState: {
          apps: {
            os: {
              appDisplayName: "OS",
              appSlug: "os",
              headSha: "current-head",
              status: "tests-failed",
              updatedAt: "2026-05-01T00:00:00.000Z",
            },
          },
          environmentConfigLease: null,
        },
        pullRequestHeadSha: "current-head",
      }).map((app) => app.slug),
    ).toEqual(["os", "auth"]);
  });

  it("does not retry previously failed apps from older commits", () => {
    expect(
      selectPreviewAppsNeedingRetry({
        previousState: {
          apps: {
            os: {
              appDisplayName: "OS",
              appSlug: "os",
              headSha: "old-head",
              status: "deploy-failed",
              updatedAt: "2026-05-01T00:00:00.000Z",
            },
          },
          environmentConfigLease: null,
        },
        pullRequestHeadSha: "current-head",
      }),
    ).toEqual([]);
  });
});
