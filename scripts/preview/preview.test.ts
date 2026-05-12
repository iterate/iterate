import { describe, expect, it } from "vitest";
import { cloudflarePreviewApps, cloudflarePreviewSharedPaths } from "./apps.ts";
import {
  batchPreviewAppsByDependencies,
  expandPreviewDependencies,
  resolvePreviewCompareBaseSha,
  selectPreviewAppsNeedingRetry,
} from "./preview.ts";

describe("preview app dependency expansion", () => {
  it("adds explicit dependencies for affected apps", () => {
    expect(expandPreviewDependencies(["events"])).toEqual(["events", "os2"]);
  });

  it("keeps independent apps as-is", () => {
    expect(expandPreviewDependencies(["os2"])).toEqual(["os2"]);
  });

  it("deduplicates dependencies", () => {
    expect(expandPreviewDependencies(["events", "os2"])).toEqual(["events", "os2"]);
  });
});

describe("preview app dependency batches", () => {
  it("keeps dependent apps after their dependencies", () => {
    expect(
      batchPreviewAppsByDependencies([cloudflarePreviewApps.os2, cloudflarePreviewApps.events]).map(
        (batch) => batch.map((app) => app.slug),
      ),
    ).toEqual([["os2"], ["events"]]);
  });

  it("keeps independent apps in the same batch", () => {
    expect(
      batchPreviewAppsByDependencies([
        cloudflarePreviewApps.example,
        cloudflarePreviewApps.semaphore,
      ]).map((batch) => batch.map((app) => app.slug)),
    ).toEqual([["example", "semaphore"]]);
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

describe("preview retry selection", () => {
  it("retries current-head failed apps and their dependencies", () => {
    expect(
      selectPreviewAppsNeedingRetry({
        previousState: {
          apps: {
            events: {
              appDisplayName: "Events",
              appSlug: "events",
              headSha: "current-head",
              status: "tests-failed",
              updatedAt: "2026-05-01T00:00:00.000Z",
            },
          },
          environmentConfigLease: null,
        },
        pullRequestHeadSha: "current-head",
      }).map((app) => app.slug),
    ).toEqual(["events", "os2"]);
  });

  it("does not retry previously failed apps from older commits", () => {
    expect(
      selectPreviewAppsNeedingRetry({
        previousState: {
          apps: {
            os2: {
              appDisplayName: "OS",
              appSlug: "os2",
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
