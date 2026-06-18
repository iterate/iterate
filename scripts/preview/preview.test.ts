import { describe, expect, it } from "vitest";
import {
  cloudflarePreviewApps,
  cloudflarePreviewAdditionalTriggerPaths,
  cloudflarePreviewSharedPaths,
} from "./apps.ts";
import {
  expandPreviewDependencies,
  orderPreviewDeployBatches,
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

describe("preview deploy ordering", () => {
  it("keeps independent apps in the same batch", () => {
    expect(
      orderPreviewDeployBatches([cloudflarePreviewApps.semaphore]).map((batch) =>
        batch.map((app) => app.slug),
      ),
    ).toEqual([["semaphore"]]);
  });

  it("deploys auth before OS when both are selected", () => {
    expect(
      orderPreviewDeployBatches([cloudflarePreviewApps.os, cloudflarePreviewApps.auth]).map(
        (batch) => batch.map((app) => app.slug),
      ),
    ).toEqual([["auth"], ["os"]]);
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

describe("preview test commands", () => {
  it("uploads both Playwright and Vitest artifacts for OS preview failures", () => {
    expect(cloudflarePreviewApps.os).toMatchObject({
      previewTestArtifacts: [
        "test-results",
        "apps/os/test-results",
        "/tmp/os-e2e-*",
        "/tmp/os-itx-e2e-*",
      ],
    });
  });

  it("runs root Playwright specs after OS preview Vitest lanes", () => {
    const script = cloudflarePreviewApps.os.previewTestCommandArgs[2];
    const playwrightInstall = "pnpm --dir ../.. exec playwright install chromium";
    const smoke = 'pnpm e2e -t "OS preview smoke"';
    const broadItx =
      "OS_ITX_E2E_FILE_PARALLELISM=true OS_ITX_E2E_EGRESS_CONCURRENT=true OS_ITX_E2E_LIVE_CONCURRENT=true OS_ITX_E2E_SKIP_MATRIX=true pnpm e2e:itx --project node";
    const matrix = "pnpm e2e:itx --project node src/itx/e2e/itx.e2e.test.ts -t 'catalogue example'";
    const playwrightSpec = "pnpm --dir ../.. spec";

    expect(script).toContain(playwrightInstall);
    expect(script).toContain(smoke);
    expect(script).toContain(broadItx);
    expect(script).toContain(matrix);
    expect(script).toContain(playwrightSpec);
    expect(script.indexOf(playwrightInstall)).toBeLessThan(script.indexOf(smoke));
    expect(script.indexOf(smoke)).toBeLessThan(script.indexOf(broadItx));
    expect(script.indexOf(broadItx)).toBeLessThan(script.indexOf(matrix));
    expect(script.indexOf(matrix)).toBeLessThan(script.indexOf(playwrightSpec));
  });
});

describe("preview readiness URLs", () => {
  it("checks the deployed app URL without probing synthetic project hostnames", () => {
    expect(
      resolvePreviewReadinessUrls({
        publicUrl: "https://os.iterate-preview-2.com",
        projectHostnameBases: ["iterate-preview-2.app", "*.iterate-preview-2.app"],
        readyUrlPath: cloudflarePreviewApps.os.previewReadyUrlPath,
      }).map((url) => url.toString()),
    ).toEqual(["https://os.iterate-preview-2.com/api/health"]);
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
