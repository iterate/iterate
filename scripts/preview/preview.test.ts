import { describe, expect, it, vi } from "vitest";
import {
  CloudflarePreviewAppEntry,
  EnvironmentConfigLease,
  cloudflarePreviewApps,
  cloudflarePreviewAdditionalTriggerPaths,
  cloudflarePreviewSharedPaths,
  environmentConfigLeaseInventory,
  previewInternals,
} from "./preview.ts";

const {
  ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
  evaluateCloudflareZoneCheck,
  expandPreviewDependencies,
  orderPreviewDeployBatches,
  parseCloudflarePreviewState,
  parseEnvironmentConfigLeaseData,
  reconcileEnvironmentConfigLeaseResources,
  renderCloudflarePreviewPullRequestBody,
  resolvePreviewCompareBaseSha,
  resolvePreviewReadinessUrls,
  selectPreviewAppsNeedingRetry,
  splitRepositoryFullName,
  syncPreviewInventory,
} = previewInternals;

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

describe("cloudflare preview state helpers", () => {
  it("round-trips rendered preview state from the managed PR body section", () => {
    const environmentConfigLease = EnvironmentConfigLease.parse({
      dopplerConfig: "preview_2",
      leasedUntil: 1_700_000_000_000,
      leaseId: "9d975621-72c8-459d-936d-e9b4335e0f5d",
      slug: "preview-2",
      type: "environment-config-lease",
    });
    const entry = CloudflarePreviewAppEntry.parse({
      appDisplayName: "OS",
      appSlug: "os",
      headSha: "abcdef0123456789",
      publicUrl: "https://os.iterate-preview-2.com",
      runUrl: "https://github.com/iterate/iterate/actions/runs/123",
      shortSha: "abcdef0",
      deployDurationMs: 12_345,
      testDurationMs: 678,
      status: "deployed",
      updatedAt: "2026-04-02T10:00:00.000Z",
    });

    const state = {
      apps: {
        os: entry,
      },
      environmentConfigLease,
    };
    const body = renderCloudflarePreviewPullRequestBody(
      "## Summary\n\nExisting user-authored description.",
      state,
    );

    expect(parseCloudflarePreviewState(body)).toEqual(state);
    expect(body).toContain("## Summary");
    expect(body).toContain("## Environment Config Lease");
    expect(body).toContain(
      "<summary>Lease: preview-2 | Doppler config: preview_2 | Type: environment-config-lease | Leased until: 2023-11-14T22:13:20.000Z</summary>\n\n| app | status | commit | preview | deploy duration | test duration | cleanup duration | workflow run | updated | summary |",
    );
    expect(body).toContain("<!-- CLOUDFLARE_PREVIEW_STATE -->");
    expect(body).toContain("<!--\n{");
    expect(body).toContain("\n-->\n<!-- /CLOUDFLARE_PREVIEW_STATE -->");
    expect(body).toContain(
      "| app | status | commit | preview | deploy duration | test duration | cleanup duration | workflow run | updated | summary |",
    );
    expect(body).toContain(
      "| OS | deployed | `abcdef0` | [https://os.iterate-preview-2.com](https://os.iterate-preview-2.com) | 12.3s | 678ms |  | [Workflow run](https://github.com/iterate/iterate/actions/runs/123) | 2026-04-02T10:00:00.000Z |  |",
    );
  });

  it("updates only the managed block and preserves surrounding PR body content", () => {
    const initialBody = [
      "# User content",
      "",
      "Owned by humans.",
      "",
      "<!-- CLOUDFLARE_PREVIEW -->",
      "old section",
      "<!-- /CLOUDFLARE_PREVIEW -->",
      "",
      "Footer",
    ].join("\n");

    const body = renderCloudflarePreviewPullRequestBody(initialBody, {
      apps: {
        os: CloudflarePreviewAppEntry.parse({
          appDisplayName: "OS",
          appSlug: "os",
          message: "AssertionError: expected 2 to be +0",
          runUrl: "https://github.com/iterate/iterate/actions/runs/456",
          shortSha: "1234567",
          status: "tests-failed",
          updatedAt: "2026-04-02T10:00:00.000Z",
        }),
      },
      environmentConfigLease: null,
    });

    expect(body).toContain("# User content");
    expect(body).toContain("Footer");
    expect(body).toContain("<summary>No active environment config lease.</summary>");
    expect(body).toContain(
      "| OS | tests failed | `1234567` |  |  |  |  | [Workflow run](https://github.com/iterate/iterate/actions/runs/456) | 2026-04-02T10:00:00.000Z | AssertionError: expected 2 to be +0 |",
    );
    expect(body).toContain("<details>");
    expect(body).toContain("<summary>OS failure details</summary>");
  });

  it("returns empty state when the managed block is deleted", () => {
    expect(parseCloudflarePreviewState("## Summary\n\nNo preview block here.")).toEqual({
      apps: {},
      environmentConfigLease: null,
    });
  });

  it("returns empty state when the managed state block is malformed", () => {
    const body = [
      "## Environment Config Lease",
      "",
      "<!-- CLOUDFLARE_PREVIEW_STATE -->",
      "<!--",
      "{ not json }",
      "-->",
      "<!-- /CLOUDFLARE_PREVIEW_STATE -->",
    ].join("\n");

    expect(parseCloudflarePreviewState(body)).toEqual({
      apps: {},
      environmentConfigLease: null,
    });
  });
});

describe("environmentConfigLeaseInventory", () => {
  it("matches the currently provisioned preview slot range", () => {
    expect(environmentConfigLeaseInventory.map((resource) => resource.slug)).toEqual([
      "preview-1",
      "preview-2",
      "preview-3",
      "preview-4",
      "preview-5",
      "preview-6",
      "preview-7",
      "preview-8",
      "preview-9",
    ]);
  });
});

describe("syncPreviewInventory", () => {
  it("adds missing shared environment config lease resources", async () => {
    const add = vi.fn(async () => undefined);
    const deleteResource = vi.fn(async () => undefined);
    const list = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await syncPreviewInventory({
      client: { add, delete: deleteResource, list },
      inventory: [
        {
          data: { dopplerConfig: "preview_2" },
          slug: "preview-2",
          type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
        },
        {
          data: { dopplerConfig: "preview_3" },
          slug: "preview-3",
          type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
        },
      ],
    });

    expect(deleteResource).not.toHaveBeenCalled();
    expect(add.mock.calls).toEqual([
      [
        {
          data: { dopplerConfig: "preview_2" },
          slug: "preview-2",
          type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
        },
      ],
      [
        {
          data: { dopplerConfig: "preview_3" },
          slug: "preview-3",
          type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
        },
      ],
    ]);
  });

  it("deletes drifted resources before recreating expected resources", async () => {
    const add = vi.fn(async () => undefined);
    const deleteResource = vi.fn(async () => undefined);
    const list = vi
      .fn()
      .mockResolvedValueOnce([
        { data: {}, slug: "preview-2" },
        { data: { dopplerConfig: "preview_3" }, slug: "preview-3" },
        { data: { dopplerConfig: "preview_99" }, slug: "preview-99" },
      ])
      .mockResolvedValueOnce([{ data: { dopplerConfig: "preview_3" }, slug: "preview-3" }]);

    await syncPreviewInventory({
      client: { add, delete: deleteResource, list },
      inventory: [
        {
          data: { dopplerConfig: "preview_2" },
          slug: "preview-2",
          type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
        },
        {
          data: { dopplerConfig: "preview_3" },
          slug: "preview-3",
          type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
        },
      ],
    });

    expect(deleteResource.mock.calls).toEqual([
      [{ slug: "preview-2", type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE }],
      [{ slug: "preview-99", type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE }],
    ]);
    expect(add.mock.calls).toEqual([
      [
        {
          data: { dopplerConfig: "preview_2" },
          slug: "preview-2",
          type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
        },
      ],
    ]);
  });
});

describe("parseEnvironmentConfigLeaseData", () => {
  it("requires a dopplerConfig string", () => {
    expect(parseEnvironmentConfigLeaseData({ dopplerConfig: " preview_2 " })).toEqual({
      dopplerConfig: "preview_2",
    });
    expect(() => parseEnvironmentConfigLeaseData({})).toThrow(
      "Environment config lease data must include dopplerConfig.",
    );
  });
});

describe("reconcileEnvironmentConfigLeaseResources", () => {
  it("checks live Semaphore leases against Doppler projects and Cloudflare zones", async () => {
    const result = await reconcileEnvironmentConfigLeaseResources({
      client: {
        list: async () => [
          {
            slug: "preview-2",
            data: { dopplerConfig: "preview_2" },
            leaseState: "available",
            leasedUntil: null,
          },
        ],
      },
      checkDopplerConfig: async () => ({ ok: true }),
      readCloudflareCredentials: async ({ project }) => ({
        ok: true,
        project,
        accountId: "cf-account",
        apiToken: "redacted",
      }),
      checkCloudflareZone: async () => ({ ok: true }),
      commandEnvironment: {},
      repositoryRoot: "/repo",
      semaphoreBaseUrl: "https://semaphore.iterate.com",
    });

    expect(result).toMatchObject({
      ok: true,
      type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
      summary: {
        issueCount: 0,
        resourceCount: 1,
      },
      resources: [
        {
          slug: "preview-2",
          dopplerConfig: "preview_2",
          domains: ["iterate-preview-2.com", "iterate-preview-2.app"],
          issues: [],
        },
      ],
    });
  });

  it("reports malformed resource data, missing Doppler configs, and inaccessible zones", async () => {
    const result = await reconcileEnvironmentConfigLeaseResources({
      client: {
        list: async () => [
          {
            slug: "preview-2",
            data: { dopplerConfig: "preview_2", note: "extra data should not live here" },
            leaseState: "leased",
            leasedUntil: 1_777_984_800_000,
          },
          {
            slug: "preview-3",
            data: { dopplerConfig: "preview_3" },
            leaseState: "available",
            leasedUntil: null,
          },
        ],
      },
      checkDopplerConfig: async ({ config, project }) =>
        project === "os" && config === "preview_3"
          ? { ok: false, message: "config not found" }
          : { ok: true },
      readCloudflareCredentials: async ({ project }) => ({
        ok: true,
        project,
        accountId: "cf-account",
        apiToken: "redacted",
      }),
      checkCloudflareZone: async ({ domain }) =>
        domain === "iterate-preview-3.app"
          ? { ok: false, message: "zone not found in Cloudflare account cf-account" }
          : { ok: true },
      commandEnvironment: {},
      repositoryRoot: "/repo",
      semaphoreBaseUrl: "https://semaphore.iterate.com",
    });

    expect(result).toMatchObject({
      ok: false,
      summary: { issueCount: 3 },
    });
    expect(result.resources.flatMap((resource) => resource.issues)).toEqual([
      {
        check: "resource-data",
        resourceSlug: "preview-2",
        message: "Resource data must contain only dopplerConfig.",
      },
      {
        check: "doppler-config",
        resourceSlug: "preview-3",
        message: "os/preview_3: config not found",
      },
      {
        check: "cloudflare-zone",
        resourceSlug: "preview-3",
        message: "iterate-preview-3.app: zone not found in Cloudflare account cf-account",
      },
    ]);
  });
});

describe("evaluateCloudflareZoneCheck", () => {
  it("rejects a moved same-account zone when DNS is delegated to a different active zone", () => {
    expect(
      evaluateCloudflareZoneCheck({
        accountId: "preview-account",
        domain: "iterate-preview-2.com",
        zones: [
          {
            account: { id: "preview-account" },
            name: "iterate-preview-2.com",
            status: "moved",
          },
          {
            account: { id: "delegated-account" },
            name: "iterate-preview-2.com",
            status: "active",
          },
        ],
      }),
    ).toEqual({
      ok: false,
      message:
        "active zone belongs to Cloudflare account delegated-account, expected preview-account",
    });
  });

  it("accepts an active zone in the expected account", () => {
    expect(
      evaluateCloudflareZoneCheck({
        accountId: "preview-account",
        domain: "iterate-preview-2.com",
        zones: [
          {
            account: { id: "preview-account" },
            name: "iterate-preview-2.com",
            status: "active",
          },
        ],
      }),
    ).toEqual({ ok: true });
  });
});

describe("splitRepositoryFullName", () => {
  it("parses owner/repo", () => {
    expect(splitRepositoryFullName("iterate/iterate")).toEqual(["iterate", "iterate"]);
  });

  it("rejects malformed repository names", () => {
    expect(() => splitRepositoryFullName("iterate")).toThrow(
      "Expected repository full name to look like owner/repo.",
    );
    expect(() => splitRepositoryFullName("iterate/iterate/extra")).toThrow(
      "Expected repository full name to look like owner/repo.",
    );
  });
});
