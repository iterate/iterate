import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  CloudflarePreviewAppEntry,
  CloudflarePreviewAppSlug,
  CloudflarePreviewSlotDisplay,
  cloudflarePreviewApps,
  cloudflarePreviewAdditionalTriggerPaths,
  cloudflarePreviewSharedPaths,
  environmentConfigLeaseInventory,
  previewInternals,
} from "./preview.ts";

const repoRoot = resolve(import.meta.dirname, "../..");

const WorkflowConcurrency = z.object({
  group: z.string(),
  "cancel-in-progress": z.boolean(),
});

const PreviewWorkflowConcurrency = z.object({
  concurrency: WorkflowConcurrency,
  jobs: z.record(z.string(), z.object({ concurrency: WorkflowConcurrency })),
});

const {
  ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
  acquireAnyEnvironmentConfigLease,
  announceRetryTelemetry,
  adoptLeaseHeldBySemaphore,
  claimEnvironmentConfigLease,
  describeForcePushCompareHazard,
  describeLostSlotOwnership,
  describePreviewSlotChange,
  destroyPreviewStackAndDeleteRecord,
  ensurePreviewStackRecord,
  evaluateCloudflareZoneCheck,
  holderPullRequestUrl,
  requireExplicitReclaimForce,
  retakeRecordedSlotIfFree,
  resolveSlotWaitTotalMs,
  expandPreviewDependencies,
  orderPreviewDeployBatches,
  parseLastDeployedWorkerVersionId,
  parseCloudflarePreviewState,
  parseEnvironmentConfigLeaseData,
  previewProvisionedIntegrationSecrets,
  readPreviewAppConfig,
  reconcileEnvironmentConfigLeaseResources,
  releaseLeaseDespiteTeardownFailure,
  renderCloudflarePreviewPullRequestBody,
  resolveAuthPreviewRootSecret,
  resolveSharedPreviewRootSecret,
  resolveProvisionAuthPreviewSlotNumbers,
  resolveRequestedPreviewEnvironment,
  resolvePreviewCompareBaseSha,
  resolvePreviewOsContainerRollout,
  resolvePreviewReadinessUrls,
  resolvePreviewRolloutReadyAtMs,
  resolvePreviewRolloutRemainingSeconds,
  resolvePreviewTestBaseUrlEnvironment,
  resolvePreviewTestTargetPlan,
  resolvePreviewTestTelemetryEnvironment,
  resolvePreviewTestWorkerVersionOverrides,
  selectPreviewStacksForGc,
  selectPreviewAppsForPullRequest,
  selectPreviewAppsNeedingRetry,
  selectPreviewAppsForTesting,
  splitRepositoryFullName,
  syncPreviewInventory,
  waitForHttpReadiness,
} = previewInternals;

test("a PR body can request one configured preview environment", () => {
  expect(
    resolveRequestedPreviewEnvironment(`
Deploy this on the expanded fleet.

preview_environment=preview-17
`),
  ).toBe("preview-17");
});

test("a preview environment directive must be unique and name configured inventory", () => {
  expect(resolveRequestedPreviewEnvironment("No environment preference.")).toBeNull();
  expect(() => resolveRequestedPreviewEnvironment("preview_environment=preview-99")).toThrow(
    /Unknown preview_environment preview-99/,
  );
  expect(() =>
    resolveRequestedPreviewEnvironment(`
preview_environment=preview-17
preview_environment=preview-18
`),
  ).toThrow(/at most one preview_environment directive/);
});

test("preview environment examples and comments are not active directives", () => {
  expect(
    resolveRequestedPreviewEnvironment(`
Example:

\`\`\`
preview_environment=preview-17
\`\`\`

<!--
preview_environment=preview-18
-->
`),
  ).toBeNull();

  expect(
    resolveRequestedPreviewEnvironment(`
\`\`\`text
preview_environment=preview-18
\`\`\`

preview_environment=preview-17
`),
  ).toBe("preview-17");
});

test("a requested slot move is not reported as a stolen lapsed lease", () => {
  expect(
    describePreviewSlotChange({
      changedAt: "2026-07-21T10:00:00.000Z",
      nextSlug: "preview-17",
      previousSlug: "preview-6",
      requestedEnvironment: "preview-17",
    }),
  ).toBe(
    "This PR requested preview-17 via preview_environment, so its slot changed from preview-6 to preview-17 at 2026-07-21T10:00:00.000Z. Everything below refers to the new slot.",
  );
});

test("Auth preview provisioning can target only an approved slot range", () => {
  expect(
    resolveProvisionAuthPreviewSlotNumbers({
      availableSlots: [1, 2, 9, 10, 11, 12, 13, 19],
      slots: "10-13,19",
    }),
  ).toEqual([10, 11, 12, 13, 19]);

  expect(() =>
    resolveProvisionAuthPreviewSlotNumbers({
      availableSlots: [1, 2, 3],
      slots: "3-4",
    }),
  ).toThrow(/unknown preview slot 4/);
});

test("Preview provisioning seeds the shared preview project-app session secret from dev", () => {
  expect(
    resolveSharedPreviewRootSecret({
      authDevSecret: "shared-non-production-secret",
      osDevSecret: "shared-non-production-secret",
      sharedPreviewSecret: null,
    }),
  ).toBe("shared-non-production-secret");
});

test("Preview provisioning preserves a matching shared preview session secret", () => {
  expect(
    resolveSharedPreviewRootSecret({
      authDevSecret: "shared-non-production-secret",
      osDevSecret: "shared-non-production-secret",
      sharedPreviewSecret: "shared-non-production-secret",
    }),
  ).toBe("shared-non-production-secret");
});

test("Preview provisioning refuses divergent project-app session roots", () => {
  expect(() =>
    resolveSharedPreviewRootSecret({
      authDevSecret: "auth-secret",
      osDevSecret: "os-secret",
      sharedPreviewSecret: null,
    }),
  ).toThrow(/dev project-app session secrets differ/);

  expect(() =>
    resolveSharedPreviewRootSecret({
      authDevSecret: "shared-non-production-secret",
      osDevSecret: "shared-non-production-secret",
      sharedPreviewSecret: "stale-preview-secret",
    }),
  ).toThrow(/shared preview project-app session secret differs from dev/);
});

test("Preview provisioning includes the Dummy Petshop client OS deploys require", () => {
  expect(
    JSON.parse(previewProvisionedIntegrationSecrets().APP_CONFIG_INTEGRATIONS__PETSHOP),
  ).toEqual({
    oauthClientId: "petshop-default",
    oauthClientSecret: "petshop-default-secret",
  });
});

describe("preview app dependency expansion", () => {
  test("expands os to include the apps exercised by its end-to-end suite", () => {
    expect(expandPreviewDependencies(["os"])).toEqual(["os", "docs", "auth", "dummy-petshop"]);
  });

  test("expands semaphore to include its auth dependency", () => {
    expect(expandPreviewDependencies(["semaphore"])).toEqual(["semaphore", "auth"]);
  });

  test("expands streams to include its auth dependency", () => {
    expect(expandPreviewDependencies(["streams-example-app"])).toEqual([
      "auth",
      "streams-example-app",
    ]);
  });

  test("expands docs to include its OS workspace backend", () => {
    expect(expandPreviewDependencies(["docs"])).toEqual(["os", "docs", "auth", "dummy-petshop"]);
  });

  test("deduplicates dependencies", () => {
    expect(expandPreviewDependencies(["os", "os", "auth"])).toEqual([
      "os",
      "docs",
      "auth",
      "dummy-petshop",
    ]);
  });
});

describe("preview deploy ordering", () => {
  test("orders only the selected apps without adding dependencies", () => {
    expect(
      orderPreviewDeployBatches([cloudflarePreviewApps.semaphore]).map((batch) =>
        batch.map((app) => app.slug),
      ),
    ).toEqual([["semaphore"]]);
  });

  test("deploys OS and its selected dependencies in one batch", () => {
    expect(
      orderPreviewDeployBatches([
        cloudflarePreviewApps.os,
        cloudflarePreviewApps.docs,
        cloudflarePreviewApps.auth,
        cloudflarePreviewApps["dummy-petshop"],
      ]).map((batch) => batch.map((app) => app.slug)),
    ).toEqual([["os", "docs", "auth", "dummy-petshop"]]);
  });

  test("deploys the whole selected fleet in one batch", () => {
    expect(
      orderPreviewDeployBatches([
        cloudflarePreviewApps.os,
        cloudflarePreviewApps.docs,
        cloudflarePreviewApps.semaphore,
        cloudflarePreviewApps["streams-example-app"],
        cloudflarePreviewApps.auth,
        cloudflarePreviewApps["dummy-petshop"],
      ]).map((batch) => batch.map((app) => app.slug)),
    ).toEqual([["os", "docs", "semaphore", "streams-example-app", "auth", "dummy-petshop"]]);
  });
});

describe("preview workflow scope", () => {
  test("includes shared preview orchestration paths", () => {
    expect(cloudflarePreviewSharedPaths).toContain("scripts/preview/**");
    expect(cloudflarePreviewSharedPaths).toContain("packages/ui/**");
    expect(cloudflarePreviewAdditionalTriggerPaths).toContain("apps/auth-example/**");
    // The preview deploy + e2e lifecycle is one Depot CI workflow; a change to
    // it triggers a full-fleet preview. Cleanup is a separate closed-event
    // workflow with no paths filter (it must run for every closed PR that
    // might hold a lease, including full reverts).
    expect(cloudflarePreviewSharedPaths).toContain(".depot/workflows/cloudflare-previews.yml");
    // Dependency manifests can change every app's build output; a diff that
    // touches only them must select the full fleet, not "no apps affected"
    // (which strands the fleet's recorded heads behind the PR head).
    expect(cloudflarePreviewSharedPaths).toContain("pnpm-lock.yaml");
    expect(cloudflarePreviewSharedPaths).toContain("pnpm-workspace.yaml");
    expect(cloudflarePreviewSharedPaths).toContain("patches/**");
  });

  test("reads every app's public preview origin from envs.ts", () => {
    expect(
      Object.fromEntries(
        Object.entries(cloudflarePreviewApps).map(([slug, app]) => [
          slug,
          app.resolvePreviewAppConfig("preview_3"),
        ]),
      ),
    ).toEqual({
      auth: {
        baseUrl: "https://auth.iterate-preview-3.com",
        workerName: "auth-preview-3",
      },
      docs: {
        baseUrl: "https://docs-preview-3.iterate-dev-preview.workers.dev",
        workerName: "docs-preview-3",
      },
      "dummy-petshop": {
        baseUrl: "https://dummy-petshop.iterate-preview-3.com",
        workerName: "dummy-petshop-preview-3",
      },
      os: {
        baseUrl: "https://os.iterate-preview-3.com",
        projectHostnameBases: ["iterate-preview-3.app"],
        workerName: "os-preview-3",
      },
      semaphore: {
        baseUrl: "https://semaphore.iterate-preview-3.com",
        workerName: "semaphore-preview-3",
      },
      "streams-example-app": {
        baseUrl: "https://streams.iterate-preview-3.com",
        workerName: "streams-example-app-preview-3",
      },
    });
  });

  test("declares and pins every runner artifact source started by preview e2e", () => {
    expect(
      Object.fromEntries(
        Object.entries(cloudflarePreviewApps).map(([slug, app]) => [
          slug,
          app.previewTestArtifactSources.map(
            ({ producer, framework, testKind, lane, workspace }) =>
              `${producer}:${framework}/${testKind}/${lane}@${workspace}`,
          ),
        ]),
      ),
    ).toEqual({
      auth: ["vitest-retry-telemetry-reporter:vitest/e2e/vitest@@iterate-com/auth"],
      docs: ["vitest-retry-telemetry-reporter:vitest/e2e/vitest@@iterate-com/docs"],
      "dummy-petshop": [
        "vitest-retry-telemetry-reporter:vitest/e2e/vitest@@iterate-com/dummy-petshop",
      ],
      os: [
        "onboarding-smoke:script/e2e/onboarding-smoke@iterate-root",
        "tui-quarantine:script/e2e/tui@iterate-root",
        "vitest-retry-telemetry-reporter:vitest/e2e/vitest@@iterate-com/os",
        "playwright-telemetry-reporter:playwright/e2e/playwright@iterate-root",
      ],
      semaphore: ["vitest-retry-telemetry-reporter:vitest/e2e/vitest@@iterate-com/semaphore"],
      "streams-example-app": [
        "vitest-retry-telemetry-reporter:vitest/e2e/vitest@@iterate-com/streams-example-app",
        "playwright-telemetry-reporter:playwright/e2e/playwright@@iterate-com/streams-example-app",
      ],
    });

    for (const app of Object.values(cloudflarePreviewApps)) {
      const command = app.previewTestCommandArgs.join(" ");
      for (const workspace of new Set(
        app.previewTestArtifactSources.map(({ workspace }) => workspace),
      )) {
        expect(command, `${app.slug} must pin ${workspace}`).toContain(
          `TEST_TELEMETRY_WORKSPACE=${workspace}`,
        );
      }
    }
  });

  test("runs the auth OAuth provider e2e against its deployed preview", () => {
    // The auth lane runs the full apps/auth/e2e suite (authorize → code →
    // token exchange), not a discovery curl: a bare metadata probe is what
    // let the 2026-07-11 streams.iterate.com stale-registration incident
    // ship silently (docs/testing.md#lanes).
    expect(cloudflarePreviewApps.auth).toMatchObject({
      appPath: "apps/auth",
      previewReadyUrlPath: "/api/auth/ok",
      previewTestBaseUrlEnvVar: "AUTH_BASE_URL",
      previewTestCommandArgs: [
        "bash",
        "-c",
        expect.stringContaining("TEST_TELEMETRY_ARTIFACT_FILE="),
      ],
    });
  });

  test("runs the dummy-petshop live e2e against its deployed preview", () => {
    const petshop = cloudflarePreviewApps["dummy-petshop"];

    expect(petshop).toMatchObject({
      appPath: "apps/dummy-petshop",
      paths: ["apps/dummy-petshop/**"],
      previewReadyUrlPath: "/",
      previewTestBaseUrlEnvVar: "PETSHOP_BASE_URL",
      previewTestCommandArgs: [
        "bash",
        "-c",
        expect.stringContaining("TEST_TELEMETRY_ARTIFACT_FILE="),
      ],
    });
    expect(
      readPreviewAppConfig({
        app: petshop,
        dopplerConfig: "preview_3",
      }),
    ).toEqual({
      baseUrl: "https://dummy-petshop.iterate-preview-3.com",
      projectHostnameBases: [],
      workerName: "dummy-petshop-preview-3",
    });
    // Only the deploy workflow is path-filtered; cleanup deliberately has no
    // paths list (it must run for every closed PR — see the cleanup-trigger
    // test below), so it is not asserted here.
    expect(
      readFileSync(resolve(repoRoot, ".depot/workflows/cloudflare-previews.yml"), "utf8"),
    ).toContain("- apps/dummy-petshop/**");
  });

  test("resolves repository-owned preview origins without duplicating them in Doppler", () => {
    expect(
      readPreviewAppConfig({
        app: cloudflarePreviewApps.semaphore,
        dopplerConfig: "preview_14",
      }),
    ).toEqual({
      baseUrl: "https://semaphore.iterate-preview-14.com",
      projectHostnameBases: [],
      workerName: "semaphore-preview-14",
    });

    expect(cloudflarePreviewApps.os.resolvePreviewAppConfig?.("preview_14")).toEqual({
      baseUrl: "https://os.iterate-preview-14.com",
      projectHostnameBases: ["iterate-preview-14.app"],
      workerName: "os-preview-14",
    });
  });

  test("deploys OS after Petshop and passes that exact preview URL to OS e2e", () => {
    const headSha = "abc1234";
    const os = cloudflarePreviewApps.os;

    expect(os).toMatchObject({
      paths: expect.arrayContaining([
        "apps/dummy-petshop/**",
        "apps/mobile/**",
        "playwright.config.ts",
        "packages/iterate/**",
        "specs/**",
      ]),
      previewDependencies: ["auth", "docs", "dummy-petshop"],
      previewTestDependencyBaseUrlEnvVars: {
        "dummy-petshop": "PETSHOP_BASE_URL",
      },
    });
    expect(
      readFileSync(resolve(repoRoot, ".depot/workflows/cloudflare-previews.yml"), "utf8"),
    ).toContain("- packages/iterate/**");
    expect(
      readFileSync(resolve(repoRoot, ".depot/workflows/cloudflare-previews.yml"), "utf8"),
    ).toContain("- specs/**");
    expect(
      resolvePreviewTestBaseUrlEnvironment({
        app: os,
        apps: {
          os: {
            headSha,
            publicUrl: "https://os.iterate-preview-7.com",
          },
          "dummy-petshop": {
            headSha,
            publicUrl: "https://dummy-petshop.iterate-preview-7.com",
          },
        },
        requiredDeploymentHeadSha: headSha,
      }),
    ).toEqual([
      "APP_CONFIG_BASE_URL=https://os.iterate-preview-7.com",
      "PETSHOP_BASE_URL=https://dummy-petshop.iterate-preview-7.com",
    ]);
  });

  test("selects OS and its dependencies for a root Playwright-only change", async () => {
    const apps = await selectPreviewAppsForPullRequest({
      githubToken: "test-token",
      previousState: {
        apps: {},
        environmentConfigLease: null,
        notice: null,
      },
      pullRequestBaseSha: "base-sha",
      pullRequestHeadSha: "current-head",
      pullRequestNumber: 2140,
      repositoryFullName: "iterate/iterate",
      fetchCompare: async () => ({
        status: "ahead",
        changedFilenames: ["specs/forged-session-repl.spec.ts"],
      }),
      probeAppServing: async () => ({ ok: true, detail: "HTTP 200" }),
    });

    expect(apps.map((app) => app.slug)).toEqual(["os", "docs", "auth", "dummy-petshop"]);
  });

  test("pins tests to every current-head deployment's exact Worker version", () => {
    const headSha = "current-head";
    const osVersion = "11111111-1111-4111-8111-111111111111";
    const authVersion = "22222222-2222-4222-8222-222222222222";
    const entry = (
      appSlug: "auth" | "os",
      appDisplayName: string,
      deployedWorkerName: string,
      deployedWorkerVersion: string,
    ) =>
      CloudflarePreviewAppEntry.parse({
        appDisplayName,
        appSlug,
        deployedWorkerName,
        deployedWorkerVersion,
        headSha,
        publicUrl: `https://${appSlug}.iterate-preview-7.com`,
        status: "awaiting-tests",
        updatedAt: "2026-07-21T00:00:00.000Z",
      });
    const apps = {
      auth: entry("auth", "Auth", "auth-preview-7", authVersion),
      os: entry("os", "OS", "os-preview-7", osVersion),
    };

    expect(
      resolvePreviewTestWorkerVersionOverrides({
        apps,
        appSlugs: ["os", "auth"],
        dopplerConfig: "preview_7",
        requiredDeploymentHeadSha: headSha,
      }),
    ).toBe(`auth-preview-7="${authVersion}",os-preview-7="${osVersion}"`);

    expect(() =>
      resolvePreviewTestWorkerVersionOverrides({
        apps: { ...apps, os: { ...apps.os, deployedWorkerVersion: null } },
        appSlugs: ["os", "auth"],
        dopplerConfig: "preview_7",
        requiredDeploymentHeadSha: headSha,
      }),
    ).toThrow(/exact os-preview-7 deployment identity is missing or stale/);
  });

  test("refuses to run OS e2e against a missing or stale Petshop deployment", () => {
    expect(() =>
      resolvePreviewTestBaseUrlEnvironment({
        app: cloudflarePreviewApps.os,
        apps: {
          os: {
            headSha: "current-head",
            publicUrl: "https://os.iterate-preview-7.com",
          },
          "dummy-petshop": {
            headSha: "older-head",
            publicUrl: "https://dummy-petshop.iterate-preview-7.com",
          },
        },
        requiredDeploymentHeadSha: "current-head",
      }),
    ).toThrow(/PETSHOP_BASE_URL requires dummy-petshop deployed at head current/);
  });

  test("reruns every app suite when unchanged deployments come from an older head", () => {
    const oldHead = "older-deployment-head";
    const osVersion = "11111111-1111-4111-8111-111111111111";
    const authVersion = "22222222-2222-4222-8222-222222222222";
    const apps = {
      auth: CloudflarePreviewAppEntry.parse({
        appDisplayName: "Auth",
        appSlug: "auth",
        deployedWorkerName: "auth-preview-7",
        deployedWorkerVersion: authVersion,
        headSha: oldHead,
        publicUrl: "https://auth.iterate-preview-7.com",
        status: "deployed",
        updatedAt: "2026-07-22T00:00:00.000Z",
      }),
      "dummy-petshop": CloudflarePreviewAppEntry.parse({
        appDisplayName: "Dummy Petshop",
        appSlug: "dummy-petshop",
        deployedWorkerName: "dummy-petshop-preview-7",
        deployedWorkerVersion: "33333333-3333-4333-8333-333333333333",
        headSha: oldHead,
        publicUrl: "https://dummy-petshop.iterate-preview-7.com",
        status: "deployed",
        updatedAt: "2026-07-22T00:00:00.000Z",
      }),
      os: CloudflarePreviewAppEntry.parse({
        appDisplayName: "OS",
        appSlug: "os",
        deployedWorkerName: "os-preview-7",
        deployedWorkerVersion: osVersion,
        headSha: oldHead,
        publicUrl: "https://os.iterate-preview-7.com",
        status: "deployed",
        updatedAt: "2026-07-22T00:00:00.000Z",
      }),
    };

    expect(selectPreviewAppsForTesting(apps).map((app) => app.slug)).toEqual([
      "auth",
      "dummy-petshop",
      "os",
    ]);
    expect(
      resolvePreviewTestWorkerVersionOverrides({
        apps,
        appSlugs: ["auth", "os"],
        dopplerConfig: "preview_7",
      }),
    ).toBe(`auth-preview-7="${authVersion}",os-preview-7="${osVersion}"`);
    expect(
      resolvePreviewTestBaseUrlEnvironment({
        app: cloudflarePreviewApps.os,
        apps,
      }),
    ).toEqual([
      "APP_CONFIG_BASE_URL=https://os.iterate-preview-7.com",
      "PETSHOP_BASE_URL=https://dummy-petshop.iterate-preview-7.com",
    ]);
  });

  test("rejects pre-RPC branches before the preview orchestrator can deploy Auth", () => {
    const workflow = readFileSync(
      resolve(repoRoot, ".depot/workflows/cloudflare-previews.yml"),
      "utf8",
    );
    const epoch = readFileSync(resolve(repoRoot, "scripts/preview/deployment-epoch"), "utf8");

    expect(epoch.trim()).toBe("os-auth-rpc-v1");
    expect(workflow).toContain('expected="os-auth-rpc-v1"');
    expect(workflow.indexOf("Enforce preview deployment epoch")).toBeLessThan(
      workflow.indexOf("pnpm preview run"),
    );
  });

  test("serializes deploy and cleanup per PR without a fleet-wide maintenance gate", () => {
    const deployWorkflowText = readFileSync(
      resolve(repoRoot, ".depot/workflows/cloudflare-previews.yml"),
      "utf8",
    );
    const cleanupWorkflowText = readFileSync(
      resolve(repoRoot, ".depot/workflows/cloudflare-preview-cleanup.yml"),
      "utf8",
    );
    const deployWorkflow = PreviewWorkflowConcurrency.parse(parseYaml(deployWorkflowText));
    const cleanupWorkflow = PreviewWorkflowConcurrency.parse(parseYaml(cleanupWorkflowText));

    expect(deployWorkflow.concurrency).toEqual({
      group:
        "cloudflare-previews-${{ github.event.pull_request.number || inputs.pull-request-number }}",
      "cancel-in-progress": true,
    });
    expect(cleanupWorkflow.concurrency).toEqual(deployWorkflow.concurrency);
    expect(deployWorkflow.jobs.preview.concurrency).toEqual({
      group:
        "cloudflare-preview-lifecycle-${{ github.event.pull_request.number || inputs.pull-request-number }}",
      "cancel-in-progress": false,
    });
    expect(cleanupWorkflow.jobs.cleanup.concurrency).toEqual({
      group: "cloudflare-preview-lifecycle-${{ github.event.pull_request.number }}",
      "cancel-in-progress": false,
    });
    expect(deployWorkflowText).not.toContain("cloudflare-preview-fleet-auth-rpc-cutover");
    expect(cleanupWorkflowText).not.toContain("cloudflare-preview-fleet-auth-rpc-cutover");
  });

  test("always runs cleanup on close with default-branch tooling (no paths filter)", () => {
    const cleanupWorkflowText = readFileSync(
      resolve(repoRoot, ".depot/workflows/cloudflare-preview-cleanup.yml"),
      "utf8",
    );
    const cleanupWorkflow = parseYaml(cleanupWorkflowText) as {
      on?: { pull_request?: { types?: string[]; paths?: string[] } };
    };

    expect(cleanupWorkflow.on?.pull_request?.types).toEqual(["closed"]);
    // A paths filter skips cleanup when the final PR diff is empty (full
    // revert) or no longer matches deploy paths — which leaks the lease.
    expect(cleanupWorkflow.on?.pull_request?.paths).toBeUndefined();
    // PR-head checkout reintroduces old bugs (e.g. bail-before-release);
    // cleanup tooling must come from the default branch.
    expect(cleanupWorkflowText).toContain("github.event.repository.default_branch");
    expect(cleanupWorkflowText).not.toContain("github.event.pull_request.head.sha");
  });

  test("sweeps durable stack obligations on a schedule from default-branch tooling", () => {
    const gcWorkflowText = readFileSync(
      resolve(repoRoot, ".depot/workflows/cloudflare-preview-gc.yml"),
      "utf8",
    );
    const gcWorkflow = parseYaml(gcWorkflowText) as {
      on?: { schedule?: { cron: string }[] };
    };

    // The GC is scheduled (the lazy half of the lifecycle), not triggered by a
    // PR event.
    expect(gcWorkflow.on?.schedule?.length).toBeGreaterThan(0);
    expect(gcWorkflowText).toContain("pnpm preview gc");
    // Runs current tooling and needs no GitHub token: stack records identify
    // cleanup obligations, while lease state protects live tenants.
    expect(gcWorkflowText).toContain("github.event.repository.default_branch");
  });
});

describe("draft preview policy", () => {
  const { decideDraftPreviewPolicy } = previewInternals;

  test.for([
    {
      name: "deploys ready PRs regardless of labels or leases",
      input: { allowDraft: false, holdsSlot: false, isDraft: false, labels: [] },
      expected: "deploy",
    },
    {
      name: "skips drafts that hold no slot",
      input: { allowDraft: false, holdsSlot: false, isDraft: true, labels: ["bug"] },
      expected: "skip",
    },
    {
      name: "gives a draft's slot back when the semaphore says it holds one without asking",
      input: { allowDraft: false, holdsSlot: true, isDraft: true, labels: [] },
      expected: "teardown",
    },
    {
      name: "deploys drafts wearing the preview label",
      input: { allowDraft: false, holdsSlot: false, isDraft: true, labels: ["preview"] },
      expected: "deploy",
    },
    {
      name: "deploys drafts when the caller explicitly allows it",
      input: { allowDraft: true, holdsSlot: false, isDraft: true, labels: [] },
      expected: "deploy",
    },
  ])("$name", ({ input, expected }) => {
    expect(decideDraftPreviewPolicy(input)).toBe(expected);
  });

  test("wires the lifecycle events and the dispatch override into the workflow", () => {
    const workflow = readFileSync(
      resolve(repoRoot, ".depot/workflows/cloudflare-previews.yml"),
      "utf8",
    );

    // Draft/label transitions must re-run the policy so a PR can claim a
    // slot (ready_for_review, labeled) or give one back (converted_to_draft,
    // unlabeled).
    expect(workflow).toContain("- ready_for_review");
    expect(workflow).toContain("- converted_to_draft");
    expect(workflow).toContain("- labeled");
    expect(workflow).toContain("- unlabeled");
    // A manual dispatch is an explicit ask for a fresh preview: it bypasses
    // the draft policy and cannot false-green after cleanup recorded this
    // exact head as released.
    expect(workflow).toContain(
      "${{ github.event_name == 'workflow_dispatch' && '--allow-draft --all-apps' || '' }}",
    );
  });
});

describe("auth preview root secrets", () => {
  test("seeds from auth/dev when the preview root has no value", () => {
    const reads: string[] = [];
    const values = new Map([["auth:dev:APP_CONFIG_EMAIL_SENDER_DOMAIN", "nustom.com"]]);

    const value = resolveAuthPreviewRootSecret({
      appConfigName: "APP_CONFIG_EMAIL_SENDER_DOMAIN",
      readSecret: (project, config, name) => {
        reads.push(`${project}:${config}:${name}`);
        return values.get(`${project}:${config}:${name}`) ?? null;
      },
    });

    expect(value).toBe("nustom.com");
    expect(reads).toEqual([
      "auth:preview:APP_CONFIG_EMAIL_SENDER_DOMAIN",
      "auth:dev:APP_CONFIG_EMAIL_SENDER_DOMAIN",
    ]);
  });

  test("keeps an existing preview root value ahead of the dev fallback", () => {
    const values = new Map([
      ["auth:preview:APP_CONFIG_EMAIL_SENDER_DOMAIN", "preview.example.com"],
      ["auth:dev:APP_CONFIG_EMAIL_SENDER_DOMAIN", "dev.example.com"],
    ]);

    expect(
      resolveAuthPreviewRootSecret({
        appConfigName: "APP_CONFIG_EMAIL_SENDER_DOMAIN",
        readSecret: (project, config, name) => values.get(`${project}:${config}:${name}`) ?? null,
      }),
    ).toBe("preview.example.com");
  });
});

describe("preview test commands", () => {
  test("uses the canonical artifact file variable for targeted test telemetry", () => {
    const source = readFileSync(resolve(repoRoot, "scripts/preview/preview.ts"), "utf8");

    expect(source).not.toContain("E2E_RETRY_TELEMETRY_FILE");
  });

  test("announces a recovered retry as a notice without overriding the command exit code", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      announceRetryTelemetry("os", {
        retried: [
          {
            lane: "vitest",
            name: "recovers",
            retryCount: 1,
            passedAfterRetry: true,
          },
        ],
      });

      expect(log).toHaveBeenCalledWith(
        expect.stringContaining(
          "::notice title=Preview e2e retries::os: 1 retried: recovers (vitest x1). Every listed retry passed;",
        ),
      );
    } finally {
      log.mockRestore();
    }
  });

  test("warns when retry telemetry still contains a failed test", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      announceRetryTelemetry("os", {
        retried: [
          {
            lane: "playwright",
            name: "still broken",
            retryCount: 1,
            passedAfterRetry: false,
          },
        ],
      });

      expect(log).toHaveBeenCalledWith(
        expect.stringContaining(
          "::warning title=Preview e2e retries::os: 1 retried: still broken (playwright x1, still failed). At least one listed retry still failed;",
        ),
      );
    } finally {
      log.mockRestore();
    }
  });

  test("builds a focused Vitest invocation from the OS app", () => {
    expect(
      resolvePreviewTestTargetPlan({
        grep: "Agent scripts can send web-chat messages",
        repositoryRoot: repoRoot,
        runner: "vitest",
        target: "e2e/vitest/itx-agents.e2e.test.ts",
      }),
    ).toEqual({
      args: [
        "e2e",
        "--project",
        "node",
        "e2e/vitest/itx-agents.e2e.test.ts",
        "--testNamePattern",
        "Agent scripts can send web-chat messages",
      ],
      command: "pnpm",
      runnerResultFiles: [],
      telemetryFile: resolve(repoRoot, "test-results/preview-target-vitest.json"),
      workingDirectory: resolve(repoRoot, "apps/os"),
    });
  });

  test("builds a focused Playwright invocation from the repository root", () => {
    const plan = resolvePreviewTestTargetPlan({
      grep: "discarding a new file",
      repositoryRoot: repoRoot,
      runner: "playwright",
      target: "specs/repo-ide.spec.ts",
    });

    expect(plan).toEqual({
      args: ["spec", "specs/repo-ide.spec.ts", "--grep", "discarding a new file"],
      command: "pnpm",
      runnerResultFiles: [resolve(repoRoot, "test-results/playwright-results.json")],
      telemetryFile: resolve(repoRoot, "test-results/preview-target-playwright-telemetry.json"),
      workingDirectory: repoRoot,
    });
    expect(plan.runnerResultFiles).not.toContain(plan.telemetryFile);
  });

  test("gives targeted and full preview tests the same exact PR identity", () => {
    expect(
      resolvePreviewTestTelemetryEnvironment({
        app: "os",
        context: {
          githubToken: "token",
          pullRequestBaseSha: "base-sha",
          pullRequestBody: "",
          pullRequestHeadSha: "head-sha",
          pullRequestHeadRef: "telemetry-branch",
          pullRequestIsDraft: false,
          pullRequestLabels: [],
          pullRequestNumber: 2237,
          repositoryFullName: "iterate/iterate",
          workflowRunUrl: "https://github.com/iterate/iterate/actions/runs/123",
        },
        previewSlot: "preview-19",
      }),
    ).toEqual({
      TEST_TELEMETRY_APP: "os",
      TEST_TELEMETRY_BRANCH: "telemetry-branch",
      TEST_TELEMETRY_HEAD_SHA: "head-sha",
      TEST_TELEMETRY_KIND: "e2e",
      TEST_TELEMETRY_PREVIEW_SLOT: "preview-19",
      TEST_TELEMETRY_PULL_REQUEST_NUMBER: "2237",
    });
  });

  test("normalizes OS preview artifacts before Depot upload", () => {
    const workflow = readFileSync(
      resolve(repoRoot, ".depot/workflows/cloudflare-previews.yml"),
      "utf8",
    );

    expect(workflow).toContain("scripts/preview/collect-test-artifacts.sh test-results");
    expect(workflow).toContain("path: test-results");
    expect(workflow).toContain("include-hidden-files: true");
    expect(workflow).not.toContain("            /tmp/os-e2e-*");

    const collector = readFileSync(
      resolve(repoRoot, "scripts/preview/collect-test-artifacts.sh"),
      "utf8",
    );
    expect(collector).toContain('copy_dir_contents "apps/os/e2e/tui-test/tui-traces"');
    expect(collector).not.toContain("preview_telemetry_candidates");
    expect(collector).not.toContain("runner-telemetry");
  });

  test("starts Playwright early while gating project-backed work and Vitest", () => {
    const script = cloudflarePreviewApps.os.previewTestCommandArgs[2];
    const playwrightInstall = "pnpm --dir ../.. exec playwright install chromium";
    const smokeLane = "pnpm exec tsx e2e/vitest/onboarding-smoke.ts";
    const tuiLane = "pnpm exec tsx e2e/tui-test/run.ts";
    const e2eLane = "pnpm e2e --project node";
    const playwrightSpec = "pnpm --dir ../.. spec";

    expect(script).toContain(playwrightInstall);
    expect(script).toContain(smokeLane);
    expect(script).toContain(tuiLane);
    expect(script).toContain(e2eLane);
    expect(script).toContain(playwrightSpec);
    expect(script).toContain(
      "env TEST_TELEMETRY_LANE=playwright TEST_TELEMETRY_WORKSPACE=iterate-root PLAYWRIGHT_PREVIEW_SLOW_FIRST=1",
    );
    expect(script).toContain('wait "$PW_INSTALL_PID"');
    expect(script).toContain("SMOKE_PID");
    expect(script).toContain("ROLLOUT_PID");
    expect(script).toContain("TUI_PID");
    expect(script).toContain("E2E_PID");
    expect(script).toContain("SPEC_PID");
    expect(script).toContain('wait "$SMOKE_PID"');
    expect(script).toContain('wait "$ROLLOUT_PID"');
    expect(script).toContain('wait "$TUI_PID"');
    expect(script).toContain('wait "$E2E_PID"');
    expect(script).toContain('[ "$SMOKE_OK" -eq 0 ]');
    expect(script).toContain('[ "$TUI_OK" -eq 0 ]');
    expect(script).toContain('[ "$E2E_OK" -eq 0 ]');
    // Independent setup starts immediately. Playwright begins as soon as
    // Chromium is ready. Its project fixture and the smoke consume the
    // absolute deadline from the environment, while the age clock gates
    // Vitest here.
    for (const lane of ["run_visible_lane rollout-settle sleep", smokeLane, tuiLane]) {
      expect(script.indexOf(lane)).toBeLessThan(script.indexOf('wait "$PW_INSTALL_PID"'));
    }
    expect(script.indexOf('wait "$PW_INSTALL_PID"')).toBeLessThan(script.indexOf(playwrightSpec));
    expect(script.indexOf(playwrightSpec)).toBeLessThan(script.indexOf('wait "$SMOKE_PID"'));
    expect(script.indexOf('wait "$SMOKE_PID"')).toBeLessThan(script.indexOf('wait "$ROLLOUT_PID"'));
    expect(script.indexOf('wait "$ROLLOUT_PID"')).toBeLessThan(script.indexOf(e2eLane));
    expect(script.indexOf('wait "$SMOKE_PID"')).toBeLessThan(script.indexOf(e2eLane));
    expect(script.indexOf(playwrightSpec)).toBeLessThan(script.indexOf('wait "$E2E_PID"'));
    expect(script).toContain(
      'run_visible_lane rollout-settle sleep "$PREVIEW_APP_ROLLOUT_REMAINING_SECONDS"',
    );
  });

  test("waits at most 90 seconds for fresh deployments whose live suites call Durable Objects", () => {
    const deployedAt = "2026-07-22T23:05:30.000Z";
    const now = Date.parse(deployedAt);

    expect(resolvePreviewRolloutRemainingSeconds({ appSlug: "os", deployedAt, nowMs: now })).toBe(
      90,
    );
    expect(
      resolvePreviewRolloutRemainingSeconds({
        appSlug: "os",
        deployedAt,
        nowMs: now + 20_001,
      }),
    ).toBe(70);
    expect(
      resolvePreviewRolloutRemainingSeconds({
        appSlug: "os",
        deployedAt,
        nowMs: now + 90_000,
      }),
    ).toBe(0);
    for (const appSlug of ["semaphore", "streams-example-app", "dummy-petshop"] as const) {
      expect(resolvePreviewRolloutRemainingSeconds({ appSlug, deployedAt, nowMs: now })).toBe(90);
      expect(resolvePreviewRolloutReadyAtMs({ appSlug, deployedAt })).toBe(now + 90_000);
    }
    expect(resolvePreviewRolloutRemainingSeconds({ appSlug: "auth", deployedAt, nowMs: now })).toBe(
      0,
    );
    expect(resolvePreviewRolloutRemainingSeconds({ appSlug: "os", nowMs: now })).toBe(0);
    expect(resolvePreviewRolloutReadyAtMs({ appSlug: "os", deployedAt })).toBe(now + 90_000);
    expect(resolvePreviewRolloutReadyAtMs({ appSlug: "auth", deployedAt })).toBe(0);
    expect(() =>
      resolvePreviewRolloutRemainingSeconds({
        appSlug: "os",
        deployedAt: "not-a-timestamp",
        nowMs: now,
      }),
    ).toThrow(/Invalid preview deployment timestamp/);
  });

  test("guards the parallel OS preview lane with target budgets", () => {
    expect(cloudflarePreviewApps.os).toMatchObject({
      previewDeployBudgetMs: 90_000,
      previewReadyWorkerVersion: true,
      previewTestRolloutGate: "inside-suite",
      previewTestBudgetMs: 100_000,
    });
    expect(cloudflarePreviewApps["streams-example-app"]).toMatchObject({
      previewReadyWorkerVersion: true,
      previewTestRolloutGate: "before-suite",
    });
    expect(cloudflarePreviewApps.semaphore.previewTestRolloutGate).toBe("before-suite");
    expect(cloudflarePreviewApps["dummy-petshop"].previewTestRolloutGate).toBe("before-suite");
    expect(cloudflarePreviewApps.auth.previewTestRolloutGate).toBeUndefined();

    const workflow = parseYaml(
      readFileSync(resolve(repoRoot, ".depot/workflows/cloudflare-previews.yml"), "utf8"),
    ) as { jobs: { preview: { "timeout-minutes": number } } };
    // This is a diagnostic backstop, not the expected duration. Individual
    // lanes retain tighter watchdogs and only tests own retries.
    expect(workflow.jobs.preview["timeout-minutes"]).toBe(20);
  });
});

describe("preview readiness URLs", () => {
  test("checks the deployed app URL without probing synthetic project hostnames", () => {
    expect(
      resolvePreviewReadinessUrls({
        publicUrl: "https://os.iterate-preview-2.com",
        projectHostnameBases: ["iterate-preview-2.app", "*.iterate-preview-2.app"],
        readyUrlPath: cloudflarePreviewApps.os.previewReadyUrlPath,
      }).map((url) => url.toString()),
    ).toEqual(["https://os.iterate-preview-2.com/api/health"]);
  });

  test("takes the final worker version when one deploy uploads sidecars before the app", () => {
    expect(
      parseLastDeployedWorkerVersionId(
        [
          "Current Version ID: 11111111-1111-4111-8111-111111111111",
          "Uploaded typechecker",
          "Current Version ID: 22222222-2222-4222-8222-222222222222",
          "Uploaded os",
          "Current Version ID: a9fcbc76-8f52-4086-9b7d-ad5db90503d0",
        ].join("\n"),
      ),
    ).toBe("a9fcbc76-8f52-4086-9b7d-ad5db90503d0");
  });

  test("returns null when wrangler did not report a deployed worker version", () => {
    expect(parseLastDeployedWorkerVersionId("Uploaded os-preview-8")).toBeNull();
  });

  test("waits for the expected edge worker version without an artificial dwell", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { "x-iterate-worker-version": "previous-version" },
        }),
      )
      .mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: { "x-iterate-worker-version": "expected-version" },
        }),
      );

    try {
      const readiness = waitForHttpReadiness({
        signal: undefined,
        timeoutMs: 10_000,
        url: new URL("https://os.iterate-preview-8.com/api/health"),
        workerVersion: { expected: "expected-version" },
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(readiness).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("preview compare base", () => {
  test("uses the pull request base before any app has deployed", () => {
    expect(
      resolvePreviewCompareBaseSha({
        previousState: {
          apps: {},
          environmentConfigLease: null,
          notice: null,
        },
        pullRequestBaseSha: "base-sha",
      }),
    ).toBe("base-sha");
  });

  test("uses the previously deployed app commit after preview state exists", () => {
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
          notice: null,
        },
        pullRequestBaseSha: "base-sha",
      }),
    ).toBe("previous-preview-sha");
  });
});

describe("preview OS container rollout", () => {
  const previousHead = "previous-preview-sha";
  const currentHead = "current-preview-sha";
  const previousState = {
    apps: {
      os: CloudflarePreviewAppEntry.parse({
        appDisplayName: "OS",
        appSlug: "os",
        deployedWorkerName: "os-preview-7",
        deployedWorkerVersion: "11111111-1111-4111-8111-111111111111",
        headSha: previousHead,
        status: "deployed",
        updatedAt: "2026-07-21T00:00:00.000Z",
      }),
    },
    environmentConfigLease: { dopplerConfig: "preview_7", slug: "preview-7" },
    notice: null,
  };

  test("skips serial stock-image builds when exact same-slot inputs are unchanged", async () => {
    await expect(
      resolvePreviewOsContainerRollout({
        dopplerConfig: "preview_7",
        githubToken: "test-token",
        nextSlotSlug: "preview-7",
        previousSlotSlug: "preview-7",
        previousState,
        pullRequestHeadSha: currentHead,
        repositoryFullName: "iterate/iterate",
        fetchCompare: async (basehead) => {
          expect(basehead).toBe(`${previousHead}...${currentHead}`);
          return {
            status: "ahead",
            changedFilenames: ["scripts/preview/preview.ts", "apps/os/scripts/deploy.ts"],
          };
        },
      }),
    ).resolves.toEqual({
      mode: "none",
      reason: `no container input changed since ${previousHead.slice(0, 7)}`,
    });
  });

  test("keeps the full rollout when a container input changed", async () => {
    await expect(
      resolvePreviewOsContainerRollout({
        dopplerConfig: "preview_7",
        githubToken: "test-token",
        nextSlotSlug: "preview-7",
        previousSlotSlug: "preview-7",
        previousState,
        pullRequestHeadSha: currentHead,
        repositoryFullName: "iterate/iterate",
        fetchCompare: async () => ({
          status: "ahead",
          changedFilenames: ["apps/os/sandbox/Dockerfile"],
        }),
      }),
    ).resolves.toEqual({
      mode: "immediate",
      reason: "container input apps/os/sandbox/Dockerfile changed",
    });
  });

  test("keeps the full rollout for a different slot without trusting a diff", async () => {
    const fetchCompare = vi.fn();
    await expect(
      resolvePreviewOsContainerRollout({
        dopplerConfig: "preview_7",
        githubToken: "test-token",
        nextSlotSlug: "preview-7",
        previousSlotSlug: "preview-6",
        previousState,
        pullRequestHeadSha: currentHead,
        repositoryFullName: "iterate/iterate",
        fetchCompare,
      }),
    ).resolves.toEqual({
      mode: "immediate",
      reason: "the preview slot is new or changed",
    });
    expect(fetchCompare).not.toHaveBeenCalled();
  });
});

describe("preview retry selection", () => {
  test.for([
    {
      name: "retries current-head failed apps and their dependencies",
      recorded: {
        appDisplayName: "OS",
        appSlug: "os",
        headSha: "current-head",
        status: "tests-failed" as const,
      },
      expected: ["os", "docs", "auth", "dummy-petshop"],
    },
    {
      // Semaphore's retry pulls in its auth dependency (relying-party JWKS).
      name: "retries apps whose slot claim failed",
      recorded: {
        appDisplayName: "Semaphore",
        appSlug: "semaphore",
        headSha: "current-head",
        status: "claim-failed" as const,
      },
      expected: ["semaphore", "auth"],
    },
    {
      // Regression: deploys failed at an old head, the next push's diff
      // selected no apps (envs.ts-only fix), and the recorded deploy-failed
      // state was never retried — deploy skipped, tests skipped, check green,
      // slot broken.
      name: "retries failed apps from older commits so a diff-miss push cannot leave the slot wedged",
      recorded: {
        appDisplayName: "OS",
        appSlug: "os",
        headSha: "old-head",
        status: "deploy-failed" as const,
      },
      expected: ["os", "docs", "auth", "dummy-petshop"],
    },
    {
      // An awaiting-tests entry at any head is a deploy whose tests never ran
      // (a cancelled run). Redeploying it at the current head is the only
      // valid route back to a tested state (observed 2026-07-10: a cancelled
      // run's deploy landed, the next push's non-app diff selected nothing,
      // and the check went green over deployments that never passed tests).
      name: "re-runs awaiting-tests apps whatever head deployed them — their e2e never ran",
      recorded: {
        appDisplayName: "OS",
        appSlug: "os",
        headSha: "old-head",
        status: "awaiting-tests" as const,
      },
      expected: ["os", "docs", "auth", "dummy-petshop"],
    },
    {
      name: "redeploys legacy green rows that cannot pin an immutable Worker version",
      recorded: {
        appDisplayName: "OS",
        appSlug: "os",
        headSha: "old-head",
        publicUrl: "https://os.iterate-preview-7.com",
        status: "deployed" as const,
      },
      expected: ["os", "docs", "auth", "dummy-petshop"],
    },
  ])("$name", ({ recorded, expected }) => {
    expect(
      selectPreviewAppsNeedingRetry({
        previousState: {
          apps: {
            [recorded.appSlug]: { ...recorded, updatedAt: "2026-05-01T00:00:00.000Z" },
          },
          environmentConfigLease: { dopplerConfig: "preview_7", slug: "preview-7" },
          notice: null,
        },
      }).map((app) => app.slug),
    ).toEqual(expected);
  });
});

describe("preview deploy selection", () => {
  const currentHead = "current-head";
  const selectionInput = {
    githubToken: "test-token",
    pullRequestBaseSha: "base-sha",
    pullRequestHeadSha: currentHead,
    pullRequestNumber: 1793,
    repositoryFullName: "iterate/iterate",
  };

  function recordedApp(
    slug: string,
    displayName: string,
    overrides: Partial<CloudflarePreviewAppEntry> = {},
  ) {
    const appSlug = CloudflarePreviewAppSlug.parse(slug);
    return CloudflarePreviewAppEntry.parse({
      appDisplayName: displayName,
      appSlug,
      deployedWorkerName:
        cloudflarePreviewApps[appSlug].resolvePreviewAppConfig("preview_7").workerName,
      deployedWorkerVersion: "11111111-1111-4111-8111-111111111111",
      headSha: currentHead,
      publicUrl: `https://${slug}.iterate-preview-7.com`,
      shortSha: "current",
      status: "deployed",
      updatedAt: "2026-07-09T00:00:00.000Z",
      ...overrides,
    });
  }

  const everythingServing = async () => ({ ok: true, detail: "HTTP 200" });
  const compareMustNotRun = async (): Promise<never> => {
    throw new Error("compare must not be called for an unchanged head");
  };

  test("selects nothing when the head is unchanged, every app is green, and every app is serving", async () => {
    const apps = await selectPreviewAppsForPullRequest({
      ...selectionInput,
      previousState: {
        apps: { os: recordedApp("os", "OS"), auth: recordedApp("auth", "Auth") },
        environmentConfigLease: { dopplerConfig: "preview_7", slug: "preview-7" },
        notice: null,
      },
      fetchCompare: compareMustNotRun,
      probeAppServing: everythingServing,
    });

    expect(apps).toEqual([]);
  });

  test("selects OS and its dependencies for an iterate package-only change", async () => {
    const apps = await selectPreviewAppsForPullRequest({
      ...selectionInput,
      previousState: {
        apps: {},
        environmentConfigLease: null,
        notice: null,
      },
      fetchCompare: async (basehead) => {
        expect(basehead).toBe(`base-sha...${currentHead}`);
        return {
          status: "ahead",
          changedFilenames: ["packages/iterate/src/stream-tui/agent-chat-terminal.tsx"],
        };
      },
      probeAppServing: everythingServing,
    });

    expect(apps.map((app) => app.slug)).toEqual(["os", "docs", "auth", "dummy-petshop"]);
  });

  test("selects Docs for an auth-only change because OS Playwright reviews a seeded document", async () => {
    const apps = await selectPreviewAppsForPullRequest({
      ...selectionInput,
      previousState: {
        apps: {},
        environmentConfigLease: null,
        notice: null,
      },
      fetchCompare: async () => ({
        status: "ahead",
        changedFilenames: ["apps/auth-contract/src/worker.ts", "apps/auth/src/server/worker.ts"],
      }),
      probeAppServing: everythingServing,
    });

    expect(apps.map((app) => app.slug)).toEqual(["os", "docs", "auth", "dummy-petshop"]);
  });

  test("selects the full fleet for an e2e policy-only change", async () => {
    const apps = await selectPreviewAppsForPullRequest({
      ...selectionInput,
      previousState: {
        apps: {},
        environmentConfigLease: null,
        notice: null,
      },
      fetchCompare: async () => ({
        status: "ahead",
        changedFilenames: ["packages/shared/src/test-support/e2e-policy/budgets.ts"],
      }),
      probeAppServing: everythingServing,
    });

    expect(apps.map((app) => app.slug)).toEqual([
      "os",
      "docs",
      "semaphore",
      "auth",
      "streams-example-app",
      "dummy-petshop",
    ]);
  });

  test("self-heals a destroyed environment: a recorded-green app is redeployed with dependencies", async () => {
    // Live incident (PR #1793 on preview-7, 2026-07-09): e2e failed with
    // "no such column: epoch", destroying the environment removed os and
    // wiped auth's D1 (OAuth clients), but os and auth
    // were recorded green — so the retry redeployed only the failed app and
    // every sign-in-dependent spec then failed on a slot with no OAuth
    // clients until auth was redeployed by hand. The probe catches the parked
    // os worker, and dependency expansion brings auth (which re-seeds its
    // OAuth clients on deploy) along.
    const probedUrls: string[] = [];
    const apps = await selectPreviewAppsForPullRequest({
      ...selectionInput,
      previousState: {
        apps: {
          os: recordedApp("os", "OS"),
          auth: recordedApp("auth", "Auth"),
          "streams-example-app": recordedApp("streams-example-app", "Streams Example App", {
            status: "tests-failed" as const,
          }),
        },
        environmentConfigLease: { dopplerConfig: "preview_7", slug: "preview-7" },
        notice: null,
      },
      fetchCompare: compareMustNotRun,
      probeAppServing: async (url) => {
        probedUrls.push(url.toString());
        return url.hostname.startsWith("os.")
          ? { ok: false, detail: "HTTP 503" }
          : { ok: true, detail: "HTTP 200" };
      },
    });

    expect(apps.map((app) => app.slug)).toEqual([
      "os",
      "docs",
      "auth",
      "streams-example-app",
      "dummy-petshop",
    ]);
    // Only green apps that have not already been selected get probed. Streams
    // failed, so it and its Auth dependency are already selected for retry.
    expect(probedUrls).toEqual(["https://os.iterate-preview-7.com/api/health"]);
  });

  test("retries failed apps even when the push's diff does not touch them", async () => {
    // A slot whose deploy failed at an old head must not stay wedged just
    // because the next push's diff selects other apps.
    const apps = await selectPreviewAppsForPullRequest({
      ...selectionInput,
      previousState: {
        apps: {
          os: recordedApp("os", "OS", {
            headSha: "old-head",
            shortSha: "oldhead",
            status: "deploy-failed" as const,
          }),
        },
        environmentConfigLease: null,
        notice: null,
      },
      fetchCompare: async (basehead) => {
        expect(basehead).toBe(`old-head...${currentHead}`);
        return { status: "ahead", changedFilenames: ["apps/semaphore/src/index.ts"] };
      },
      probeAppServing: everythingServing,
    });

    expect(apps.map((app) => app.slug)).toEqual([
      "os",
      "docs",
      "semaphore",
      "auth",
      "dummy-petshop",
    ]);
  });

  test("deploys the full fleet when the compare 404s because a force-push rewrote the deployed head away", async () => {
    const apps = await selectPreviewAppsForPullRequest({
      ...selectionInput,
      previousState: {
        apps: {
          os: recordedApp("os", "OS", { headSha: "rewritten-away-head", shortSha: "rewritt" }),
        },
        environmentConfigLease: null,
        notice: null,
      },
      fetchCompare: async () => {
        throw Object.assign(new Error("Not Found"), { status: 404 });
      },
      probeAppServing: everythingServing,
    });

    expect(apps.map((app) => app.slug)).toEqual([
      "os",
      "docs",
      "semaphore",
      "auth",
      "streams-example-app",
      "dummy-petshop",
    ]);
  });

  test("deploys the full fleet when the deployed head is no longer an ancestor of the current head", async () => {
    // A diverged (or behind) compare diffs from the merge base and cannot see
    // changes that existed only on the deployed side — which the slot still
    // runs. An empty file list here must not read as "nothing affected".
    const apps = await selectPreviewAppsForPullRequest({
      ...selectionInput,
      previousState: {
        apps: {
          os: recordedApp("os", "OS", { headSha: "diverged-head", shortSha: "diverge" }),
        },
        environmentConfigLease: null,
        notice: null,
      },
      fetchCompare: async () => ({ status: "diverged", changedFilenames: [] }),
      probeAppServing: everythingServing,
    });

    expect(apps.map((app) => app.slug)).toEqual([
      "os",
      "docs",
      "semaphore",
      "auth",
      "streams-example-app",
      "dummy-petshop",
    ]);
  });

  test("propagates non-404 compare failures instead of guessing a selection", async () => {
    await expect(
      selectPreviewAppsForPullRequest({
        ...selectionInput,
        previousState: {
          apps: {
            os: recordedApp("os", "OS", { headSha: "old-head", shortSha: "oldhead" }),
          },
          environmentConfigLease: null,
          notice: null,
        },
        fetchCompare: async () => {
          throw Object.assign(new Error("Server Error"), { status: 500 });
        },
        probeAppServing: everythingServing,
      }),
    ).rejects.toThrow("Server Error");
  });
});

describe("describeForcePushCompareHazard", () => {
  test("trusts the normal push shapes", () => {
    expect(describeForcePushCompareHazard("ahead")).toBeNull();
    expect(describeForcePushCompareHazard("identical")).toBeNull();
  });

  test("flags rewritten history as untrustworthy for diffing", () => {
    expect(describeForcePushCompareHazard("diverged")).toContain("not an ancestor");
    expect(describeForcePushCompareHazard("behind")).toContain("not an ancestor");
  });
});

describe("cloudflare preview state helpers", () => {
  test("round-trips rendered preview state from the managed PR body section", () => {
    const environmentConfigLease = CloudflarePreviewSlotDisplay.parse({
      dopplerConfig: "preview_2",
      slug: "preview-2",
    });
    const entry = CloudflarePreviewAppEntry.parse({
      appDisplayName: "OS",
      appSlug: "os",
      headSha: "abcdef0123456789",
      publicUrl: "https://os.iterate-preview-2.com",
      runUrl: "https://github.com/iterate/iterate/actions/runs/123",
      shortSha: "abcdef0",
      deployDurationMs: 12_345,
      deployedWorkerName: "os-preview-2",
      deployedWorkerVersion: "11111111-1111-4111-8111-111111111111",
      testDurationMs: 678,
      status: "deployed",
      updatedAt: "2026-04-02T10:00:00.000Z",
      workerSizeKib: 91_000.5,
      workerGzipKib: 3_500,
      mainWorkerGzipKib: 3_450,
    });

    const state = {
      apps: {
        os: entry,
      },
      environmentConfigLease,
      notice: null,
    };
    const body = renderCloudflarePreviewPullRequestBody(
      "## Summary\n\nExisting user-authored description.",
      state,
    );

    expect(parseCloudflarePreviewState(body)).toEqual(state);
    expect(body).toContain("## Summary");
    expect(body).toContain("## Environment Config Lease");
    expect(body).toContain(
      "<summary>Slot: preview-2 | Doppler config: preview_2</summary>\n\n| app | status | commit | preview | size (gzip) | deploy duration | test duration | retries | cleanup duration | workflow run | updated | summary |",
    );
    expect(body).toContain("<!-- CLOUDFLARE_PREVIEW_STATE -->");
    expect(body).toContain("<!--\n{");
    expect(body).toContain("\n-->\n<!-- /CLOUDFLARE_PREVIEW_STATE -->");
    expect(body).toContain(
      "| app | status | commit | preview | size (gzip) | deploy duration | test duration | retries | cleanup duration | workflow run | updated | summary |",
    );
    expect(body).toContain(
      "| OS | deployed | `abcdef0` | [https://os.iterate-preview-2.com](https://os.iterate-preview-2.com) | 3.42 MiB (+50.0 KiB vs main) | 12.3s | 678ms |  |  | [Workflow run](https://github.com/iterate/iterate/actions/runs/123) | 2026-04-02T10:00:00.000Z |  |",
    );
  });

  test("updates only the managed block and preserves surrounding PR body content", () => {
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
          status: "tests-failed" as const,
          updatedAt: "2026-04-02T10:00:00.000Z",
        }),
      },
      environmentConfigLease: null,
      notice: null,
    });

    expect(body).toContain("# User content");
    expect(body).toContain("Footer");
    expect(body).toContain("<summary>No preview slot recorded.</summary>");
    expect(body).toContain(
      "| OS | tests failed | `1234567` |  |  |  |  |  |  | [Workflow run](https://github.com/iterate/iterate/actions/runs/456) | 2026-04-02T10:00:00.000Z | AssertionError: expected 2 to be +0 |",
    );
    expect(body).toContain("<details>");
    expect(body).toContain("<summary>OS failure details</summary>");
  });

  test("returns empty state when the managed block is deleted", () => {
    expect(parseCloudflarePreviewState("## Summary\n\nNo preview block here.")).toEqual({
      apps: {},
      environmentConfigLease: null,
      notice: null,
    });
  });

  test("strips legacy lease fields from bodies written before the semaphore became the single lease truth", () => {
    // Old bodies persisted the full lease (leaseId, leasedUntil, type). The
    // display schema keeps only slot + doppler config; the rest must parse
    // away cleanly rather than blanking the whole recorded state.
    const body = renderCloudflarePreviewPullRequestBody("", {
      apps: {},
      environmentConfigLease: {
        dopplerConfig: "preview_2",
        leasedUntil: 1_700_000_000_000,
        leaseId: "9d975621-72c8-459d-936d-e9b4335e0f5d",
        slug: "preview-2",
        type: "environment-config-lease",
        // oxlint-disable-next-line no-explicit-any
      } as any,
      notice: null,
    });

    expect(parseCloudflarePreviewState(body).environmentConfigLease).toEqual({
      dopplerConfig: "preview_2",
      slug: "preview-2",
    });
  });

  test("returns empty state when the managed state block is malformed", () => {
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
      notice: null,
    });
  });
});

describe("syncPreviewInventory", () => {
  test("adds missing shared environment config lease resources", async () => {
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

  test("deletes drifted resources before recreating expected resources", async () => {
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
  test("requires a dopplerConfig string", () => {
    expect(parseEnvironmentConfigLeaseData({ dopplerConfig: " preview_2 " })).toEqual({
      dopplerConfig: "preview_2",
    });
    expect(() => parseEnvironmentConfigLeaseData({})).toThrow(
      "Environment config lease data must include dopplerConfig.",
    );
  });
});

describe("reconcileEnvironmentConfigLeaseResources", () => {
  test("checks live Semaphore leases against Doppler projects and Cloudflare zones", async () => {
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

  test("reports malformed resource data, missing Doppler configs, and inaccessible zones", async () => {
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
  test("rejects a moved same-account zone when DNS is delegated to a different active zone", () => {
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

  test("accepts an active zone in the expected account", () => {
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
  test("parses owner/repo", () => {
    expect(splitRepositoryFullName("iterate/iterate")).toEqual(["iterate", "iterate"]);
  });

  test("rejects malformed repository names", () => {
    expect(() => splitRepositoryFullName("iterate")).toThrow(
      "Expected repository full name to look like owner/repo.",
    );
    expect(() => splitRepositoryFullName("iterate/iterate/extra")).toThrow(
      "Expected repository full name to look like owner/repo.",
    );
  });
});

describe("preview section notice banner", () => {
  test("renders the notice as a GitHub caution alert above the lease details", () => {
    const body = renderCloudflarePreviewPullRequestBody(
      "",
      // oxlint-disable-next-line no-explicit-any
      {
        apps: {},
        environmentConfigLease: null,
        notice: "All preview slots are leased.\n  preview-1  leased by pr-1601",
      } as any,
    );
    expect(body).toContain("> [!CAUTION]");
    expect(body).toContain("> All preview slots are leased.");
    expect(body).toContain("> " + "  preview-1  leased by pr-1601");
  });

  test("renders no alert when there is no notice", () => {
    const body = renderCloudflarePreviewPullRequestBody(
      "",
      // oxlint-disable-next-line no-explicit-any
      { apps: {}, environmentConfigLease: null, notice: null } as any,
    );
    expect(body).not.toContain("[!CAUTION]");
  });
});

describe("lease holder helpers", () => {
  test("derives a PR url from pr-N holders", () => {
    expect(holderPullRequestUrl("pr-1592")).toBe("https://github.com/iterate/iterate/pull/1592");
    expect(holderPullRequestUrl("manual-jonas")).toBeNull();
    expect(holderPullRequestUrl(null)).toBeNull();
  });

  test("parses PREVIEW_SLOT_WAIT_MS overrides", () => {
    expect(resolveSlotWaitTotalMs({})).toBe(6 * 60 * 1000);
    expect(resolveSlotWaitTotalMs({ PREVIEW_SLOT_WAIT_MS: "0" })).toBe(0);
    expect(resolveSlotWaitTotalMs({ PREVIEW_SLOT_WAIT_MS: "5000" })).toBe(5000);
    expect(() => resolveSlotWaitTotalMs({ PREVIEW_SLOT_WAIT_MS: "later" })).toThrow(
      "PREVIEW_SLOT_WAIT_MS",
    );
  });
});

type FakeLease = {
  data: Record<string, unknown>;
  expiresAt: number;
  holder?: string | null;
  leaseId: string;
  slug: string;
  type: string;
};

function fakeLease(overrides: Partial<FakeLease> = {}): FakeLease {
  return {
    data: { dopplerConfig: "preview_2" },
    expiresAt: Date.now() + 60_000,
    holder: "pr-1600",
    leaseId: "9d975621-72c8-459d-936d-e9b4335e0f5d",
    slug: "preview-2",
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
    ...overrides,
  };
}

function fakeSemaphore(overrides: Record<string, unknown> = {}) {
  return {
    add: vi.fn(async () => ({})),
    acquire: vi.fn(async () => fakeLease()),
    acquireSpecific: vi.fn(async () => null),
    delete: vi.fn(async () => ({ deleted: true })),
    release: vi.fn(async () => ({ released: true })),
    list: vi.fn(async () => []),
    ...overrides,
  };
}

/** A semaphore `list` row showing `slug` leased to `holder`. */
function leasedResource(slug: string, holder: string, dopplerConfig = slug.replaceAll("-", "_")) {
  return {
    data: { dopplerConfig },
    holder,
    lastAcquiredAt: null,
    lastReleasedAt: null,
    leaseState: "leased" as const,
    leasedUntil: Date.now() + 60_000,
    slug,
  };
}

// Every tenant handover must destroy the previous environment; tests that do
// not exercise the destroy share this inert implementation.
const noopDestroyPreviewEnvironment = async () => {};

describe("claimEnvironmentConfigLease", () => {
  test("adopts (and thereby renews) the slot the semaphore attributes to this holder", async () => {
    // The PR body's copy is never consulted for ownership: the semaphore says
    // pr-1600 holds preview-2, so the claim re-issues that lease. Matching
    // the recorded slug means the slot carries this PR's own deployment — no
    // destroy.
    const destroyEnvironment = vi.fn(async () => {});
    const semaphore = fakeSemaphore({
      acquireSpecific: vi.fn(async () => fakeLease({ expiresAt: 1_800_000_000_000 })),
      list: vi.fn(async () => [leasedResource("preview-2", "pr-1600")]),
    });

    const { lease, stackWasDestroyed } = await claimEnvironmentConfigLease({
      destroyEnvironment,
      holder: "pr-1600",
      leaseMs: 1000,
      recordedSlug: "preview-2",
      semaphore,
      waitTotalMs: 0,
    });

    expect(lease.slug).toBe("preview-2");
    expect(lease.leasedUntil).toBe(1_800_000_000_000);
    expect(semaphore.acquireSpecific).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ slug: "preview-2", holder: "pr-1600", force: true }),
    );
    expect(semaphore.acquire).not.toHaveBeenCalled();
    expect(destroyEnvironment).not.toHaveBeenCalled();
    expect(stackWasDestroyed).toBe(false);
  });

  test("prefers the recorded slug when the semaphore attributes several slots to this holder", async () => {
    const semaphore = fakeSemaphore({
      acquireSpecific: vi.fn(async (input: { slug: string }) =>
        fakeLease({ slug: input.slug, data: { dopplerConfig: input.slug.replaceAll("-", "_") } }),
      ),
      list: vi.fn(async () => [
        leasedResource("preview-3", "pr-1600"),
        leasedResource("preview-2", "pr-1600"),
      ]),
    });

    const { lease } = await claimEnvironmentConfigLease({
      destroyEnvironment: noopDestroyPreviewEnvironment,
      holder: "pr-1600",
      leaseMs: 1000,
      recordedSlug: "preview-2",
      semaphore,
      waitTotalMs: 0,
    });

    expect(lease.slug).toBe("preview-2");
    expect(semaphore.acquireSpecific).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ slug: "preview-2" }),
    );
  });

  test("re-takes the recorded slot when the lease lapsed but the slot is free", async () => {
    const acquireSpecific = vi.fn(async (input: { force?: boolean }) =>
      // Only the non-force affinity re-take can succeed: the semaphore lists
      // nothing for this holder, so no adoption happens first.
      input.force ? null : fakeLease({ leaseId: "1197a5b3-a705-4380-9958-6a0dbead16b7" }),
    );
    const semaphore = fakeSemaphore({ acquireSpecific });

    const { lease, stackWasDestroyed } = await claimEnvironmentConfigLease({
      destroyEnvironment: noopDestroyPreviewEnvironment,
      holder: "pr-1600",
      leaseMs: 1000,
      recordedSlug: "preview-2",
      semaphore,
      waitTotalMs: 0,
    });

    expect(lease.slug).toBe("preview-2");
    expect(lease.leaseId).toBe("1197a5b3-a705-4380-9958-6a0dbead16b7");
    expect(acquireSpecific).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ slug: "preview-2", holder: "pr-1600" }),
    );
    expect(acquireSpecific).toHaveBeenCalledWith(expect.not.objectContaining({ force: true }));
    expect(semaphore.acquire).not.toHaveBeenCalled();
    expect(stackWasDestroyed).toBe(false);
  });

  test("moves to a fresh slot when someone else now holds the recorded one", async () => {
    const semaphore = fakeSemaphore({
      acquire: vi.fn(async () =>
        fakeLease({ slug: "preview-5", data: { dopplerConfig: "preview_5" } }),
      ),
      list: vi.fn(async () => [leasedResource("preview-2", "pr-1601")]),
    });

    const { lease, stackWasDestroyed } = await claimEnvironmentConfigLease({
      destroyEnvironment: noopDestroyPreviewEnvironment,
      holder: "pr-1600",
      leaseMs: 1000,
      recordedSlug: "preview-2",
      semaphore,
      waitTotalMs: 0,
    });

    expect(lease.slug).toBe("preview-5");
    expect(lease.dopplerConfig).toBe("preview_5");
    expect(semaphore.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedSlugs: environmentConfigLeaseInventory.map((resource) => resource.slug),
        holder: "pr-1600",
      }),
    );
    expect(stackWasDestroyed).toBe(true);
  });

  test("reports a destroyed stack when a fresh acquire returns the recorded slug", async () => {
    const destroyEnvironment = vi.fn(async () => {});
    const semaphore = fakeSemaphore({
      acquire: vi.fn(async () => fakeLease({ slug: "preview-2" })),
      acquireSpecific: vi.fn(async () => null),
    });

    const { lease, stackWasDestroyed } = await claimEnvironmentConfigLease({
      destroyEnvironment,
      holder: "pr-1600",
      leaseMs: 1000,
      recordedSlug: "preview-2",
      semaphore,
      waitTotalMs: 0,
    });

    expect(lease.slug).toBe("preview-2");
    expect(stackWasDestroyed).toBe(true);
    expect(destroyEnvironment).toHaveBeenCalledOnce();
  });

  test("adopts a lease the semaphore already attributes to this holder instead of taking a second slot", async () => {
    // A cancelled run acquired preview-3 but died before recording it in the
    // PR body: the next run starts with no recorded slot, and must re-issue
    // the existing hold rather than lease a second slot.
    const semaphore = fakeSemaphore({
      acquireSpecific: vi.fn(async () =>
        fakeLease({ slug: "preview-3", data: { dopplerConfig: "preview_3" } }),
      ),
      list: vi.fn(async () => [leasedResource("preview-3", "pr-1600")]),
    });

    const { lease } = await claimEnvironmentConfigLease({
      destroyEnvironment: noopDestroyPreviewEnvironment,
      holder: "pr-1600",
      leaseMs: 1000,
      recordedSlug: null,
      semaphore,
      waitTotalMs: 0,
    });

    expect(lease.slug).toBe("preview-3");
    expect(semaphore.acquireSpecific).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "preview-3", holder: "pr-1600", force: true }),
    );
    expect(semaphore.acquire).not.toHaveBeenCalled();
  });

  test("destroys an adopted slot that is not the PR body's recorded one", async () => {
    // The adopted lease exists precisely because a previous run died before
    // recording it — possibly mid-destroy — so its provenance is unknown.
    const destroyEnvironment = vi.fn(async () => {});
    const semaphore = fakeSemaphore({
      acquireSpecific: vi.fn(async () =>
        fakeLease({ slug: "preview-3", data: { dopplerConfig: "preview_three" } }),
      ),
      list: vi.fn(async () => [leasedResource("preview-3", "pr-1600", "preview_three")]),
    });

    const { lease, stackWasDestroyed } = await claimEnvironmentConfigLease({
      destroyEnvironment,
      holder: "pr-1600",
      leaseMs: 1000,
      recordedSlug: null,
      semaphore,
      waitTotalMs: 0,
    });

    expect(lease.slug).toBe("preview-3");
    expect(destroyEnvironment).toHaveBeenCalledExactlyOnceWith({
      dopplerConfig: "preview_three",
      slug: "preview-3",
    });
    expect(stackWasDestroyed).toBe(true);
  });

  test("propagates unexpected semaphore errors instead of silently switching slots", async () => {
    const semaphore = fakeSemaphore({
      list: vi.fn(async () => {
        throw new Error("semaphore is down");
      }),
    });

    await expect(
      claimEnvironmentConfigLease({
        destroyEnvironment: noopDestroyPreviewEnvironment,
        holder: "pr-1600",
        leaseMs: 1000,
        recordedSlug: "preview-2",
        semaphore,
        waitTotalMs: 0,
      }),
    ).rejects.toThrow("semaphore is down");
    expect(semaphore.acquire).not.toHaveBeenCalled();
  });
});

describe("acquireAnyEnvironmentConfigLease", () => {
  function conflictError() {
    const error = new Error("No resource is currently available for this type.");
    (error as Error & { code: string }).code = "CONFLICT";
    return error;
  }

  test("queues while all slots are leased and takes the first free one", async () => {
    const acquire = vi
      .fn()
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValueOnce(
        fakeLease({ slug: "preview-7", data: { dopplerConfig: "preview_7" } }),
      );
    const semaphore = fakeSemaphore({ acquire });

    const lease = await acquireAnyEnvironmentConfigLease({
      destroyEnvironment: noopDestroyPreviewEnvironment,
      semaphore,
      holder: "pr-1600",
      leaseMs: 1000,
      waitTotalMs: 60_000,
    });

    expect(lease.slug).toBe("preview-7");
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  test("fails with the holder table and remediation once the wait budget is spent", async () => {
    const semaphore = fakeSemaphore({
      acquire: vi.fn(async () => {
        throw conflictError();
      }),
      list: vi.fn(async () => [
        {
          data: { dopplerConfig: "preview_1" },
          holder: "pr-1601",
          lastAcquiredAt: null,
          lastReleasedAt: null,
          leaseState: "leased" as const,
          leasedUntil: Date.now() + 3_600_000,
          slug: "preview-1",
        },
      ]),
    });

    await expect(
      acquireAnyEnvironmentConfigLease({
        destroyEnvironment: noopDestroyPreviewEnvironment,
        semaphore,
        holder: "pr-1600",
        leaseMs: 1000,
        waitTotalMs: 0,
      }),
    ).rejects.toThrow(/pr-1601[\s\S]*preview reclaim --slot N/);
  });

  test("propagates non-contention errors immediately", async () => {
    const semaphore = fakeSemaphore({
      acquire: vi.fn(async () => {
        throw new Error("UNAUTHORIZED");
      }),
    });

    await expect(
      acquireAnyEnvironmentConfigLease({
        destroyEnvironment: noopDestroyPreviewEnvironment,
        semaphore,
        holder: "pr-1600",
        leaseMs: 1000,
        waitTotalMs: 60_000,
      }),
    ).rejects.toThrow("UNAUTHORIZED");
  });
});

describe("adoptLeaseHeldBySemaphore", () => {
  test("re-issues the holder's lease under a fresh leaseId — no stored leaseId is ever consulted", async () => {
    const acquireSpecific = vi.fn(async (input: { force?: boolean }) =>
      input.force ? fakeLease({ leaseId: "1197a5b3-a705-4380-9958-6a0dbead16b7" }) : null,
    );
    const semaphore = fakeSemaphore({
      acquireSpecific,
      list: vi.fn(async () => [leasedResource("preview-2", "pr-1600")]),
    });

    const lease = await adoptLeaseHeldBySemaphore({
      holder: "pr-1600",
      leaseMs: 1000,
      preferSlug: "preview-2",
      semaphore,
    });

    expect(lease?.leaseId).toBe("1197a5b3-a705-4380-9958-6a0dbead16b7");
    expect(acquireSpecific).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
  });

  test("returns null when the semaphore attributes nothing to the holder", async () => {
    const semaphore = fakeSemaphore({
      list: vi.fn(async () => [leasedResource("preview-2", "pr-1601")]),
    });

    expect(
      await adoptLeaseHeldBySemaphore({
        holder: "pr-1600",
        leaseMs: 1000,
        preferSlug: "preview-2",
        semaphore,
      }),
    ).toBeNull();
    expect(semaphore.acquireSpecific).not.toHaveBeenCalled();
  });

  test("moves to the holder's next slot when onAdopted rejects one", async () => {
    const semaphore = fakeSemaphore({
      acquireSpecific: vi.fn(async (input: { slug: string }) =>
        fakeLease({ slug: input.slug, data: { dopplerConfig: input.slug.replaceAll("-", "_") } }),
      ),
      list: vi.fn(async () => [
        leasedResource("preview-2", "pr-1600"),
        leasedResource("preview-3", "pr-1600"),
      ]),
    });

    const lease = await adoptLeaseHeldBySemaphore({
      holder: "pr-1600",
      leaseMs: 1000,
      onAdopted: async (adopted) => adopted.slug !== "preview-2",
      preferSlug: "preview-2",
      semaphore,
    });

    expect(lease?.slug).toBe("preview-3");
  });
});

describe("retakeRecordedSlotIfFree", () => {
  test("takes the recorded slot back without force so the semaphore still arbitrates", async () => {
    const acquireSpecific = vi.fn(async () => fakeLease());
    const semaphore = fakeSemaphore({ acquireSpecific });

    const lease = await retakeRecordedSlotIfFree({
      holder: "pr-1600",
      leaseMs: 1000,
      recordedSlug: "preview-2",
      semaphore,
    });

    expect(lease?.slug).toBe("preview-2");
    expect(acquireSpecific).toHaveBeenCalledExactlyOnceWith(
      expect.not.objectContaining({ force: true }),
    );
  });

  test("returns null when the slot is held (or nothing is recorded)", async () => {
    const semaphore = fakeSemaphore();

    expect(
      await retakeRecordedSlotIfFree({
        holder: "pr-1600",
        leaseMs: 1000,
        recordedSlug: "preview-2",
        semaphore,
      }),
    ).toBeNull();
    expect(
      await retakeRecordedSlotIfFree({
        holder: "pr-1600",
        leaseMs: 1000,
        recordedSlug: null,
        semaphore,
      }),
    ).toBeNull();
  });
});

describe("describeLostSlotOwnership", () => {
  // "no longer belongs to" is a dialed-by-name contract: the flake-hunt loop
  // (scripts/preview/flake-hunt-loop.sh) and humans grep run logs for it to
  // tell a slot steal apart from ordinary failures.
  test("names the slot, the thief, and their PR — and keeps the grep contract", () => {
    const message = describeLostSlotOwnership({
      currentHolder: "pr-1601",
      displaySlot: { dopplerConfig: "preview_2", slug: "preview-2" },
      holder: "pr-1600",
    });

    expect(message).toContain("no longer belongs to");
    expect(message).toContain("preview-2");
    expect(message).toContain("pr-1601");
    expect(message).toContain("https://github.com/iterate/iterate/pull/1601");
  });

  test("keeps the grep contract even when no slot was ever recorded", () => {
    expect(
      describeLostSlotOwnership({ currentHolder: null, displaySlot: null, holder: "pr-1600" }),
    ).toContain("no longer belongs to");
  });
});

describe("lease reclaim verdicts", () => {
  const { classifyLeaseForReclaim } = previewInternals;
  const hourMs = 3_600_000;
  const now = 1_700_000_000_000;

  test("classifies unleased slots as available", () => {
    expect(
      classifyLeaseForReclaim({
        holderPullRequestState: null,
        lastAcquiredAt: null,
        leaseState: "available",
        minIdleMs: 6 * hourMs,
        now,
      }),
    ).toBe("available");
  });

  test("reports closed-PR holders as orphan candidates regardless of recency", () => {
    expect(
      classifyLeaseForReclaim({
        holderPullRequestState: "closed",
        lastAcquiredAt: now - 1_000,
        leaseState: "leased",
        minIdleMs: 6 * hourMs,
        now,
      }),
    ).toBe("orphaned");
  });

  test("treats failed PR-state checks as active regardless of idleness", () => {
    expect(
      classifyLeaseForReclaim({
        holderPullRequestState: "unknown",
        lastAcquiredAt: now - 100 * hourMs,
        leaseState: "leased",
        minIdleMs: 6 * hourMs,
        now,
      }),
    ).toBe("active");
  });

  test("classifies stale open holds as idle and fresh ones as active", () => {
    expect(
      classifyLeaseForReclaim({
        holderPullRequestState: "open",
        lastAcquiredAt: now - 7 * hourMs,
        leaseState: "leased",
        minIdleMs: 6 * hourMs,
        now,
      }),
    ).toBe("idle");
    expect(
      classifyLeaseForReclaim({
        holderPullRequestState: "open",
        lastAcquiredAt: now - hourMs,
        leaseState: "leased",
        minIdleMs: 6 * hourMs,
        now,
      }),
    ).toBe("active");
  });
});

describe("preview fleet capacity diagnosis", () => {
  const { diagnosePreviewFleetCapacity, pullRequestWouldClaimPreviewSlot } = previewInternals;

  test("treats ready PRs and preview-labeled drafts as slot-eligible", () => {
    expect(pullRequestWouldClaimPreviewSlot({ isDraft: false, labels: [] })).toBe(true);
    expect(pullRequestWouldClaimPreviewSlot({ isDraft: true, labels: ["preview"] })).toBe(true);
    expect(pullRequestWouldClaimPreviewSlot({ isDraft: true, labels: [] })).toBe(false);
  });

  test("does not call a label-less draft slot-less when it actually holds one (--allow-draft)", () => {
    const diagnosis = diagnosePreviewFleetCapacity({
      openPullRequests: [
        {
          number: 4242,
          title: "draft dispatched with --allow-draft",
          url: "https://github.com/iterate/iterate/pull/4242",
          isDraft: true,
          labels: [],
        },
      ],
      slots: [
        {
          slug: "preview-1",
          verdict: "active",
          holder: "pr-4242",
          pullRequestUrl: "https://github.com/iterate/iterate/pull/4242",
          pullRequestState: "open",
          leasedUntil: "2026-07-16T09:20:18.639Z",
          lastUsedAgo: "2m ago",
        },
      ],
    });

    // It holds a slot, so it must not be reported as "correctly claims no slot".
    expect(diagnosis.holdersWithOpenPrs).toContain(4242);
    expect(diagnosis.reasons.some((reason) => reason.includes("claim no slot"))).toBe(false);
  });

  test("explains a full fleet held mostly by closed PRs despite few open ones", () => {
    const diagnosis = diagnosePreviewFleetCapacity({
      openPullRequests: [
        {
          number: 2008,
          title: "ready pr without a slot",
          url: "https://github.com/iterate/iterate/pull/2008",
          isDraft: false,
          labels: [],
        },
        {
          number: 1983,
          title: "draft without opt-in",
          url: "https://github.com/iterate/iterate/pull/1983",
          isDraft: true,
          labels: [],
        },
      ],
      slots: [
        {
          slug: "preview-1",
          verdict: "orphaned",
          holder: "pr-1990",
          pullRequestUrl: "https://github.com/iterate/iterate/pull/1990",
          pullRequestState: "closed",
          leasedUntil: "2026-07-15T13:53:39.946Z",
          lastUsedAgo: "19h ago",
        },
        {
          slug: "preview-2",
          verdict: "active",
          holder: "pr-2006",
          pullRequestUrl: "https://github.com/iterate/iterate/pull/2006",
          pullRequestState: "open",
          leasedUntil: "2026-07-16T09:20:18.639Z",
          lastUsedAgo: "2m ago",
        },
      ],
    });

    expect(diagnosis.availableCount).toBe(0);
    expect(diagnosis.leasedCount).toBe(2);
    expect(diagnosis.orphanedCount).toBe(1);
    expect(diagnosis.previewEligibleWithoutSlotCount).toBe(1);
    expect(diagnosis.reclaimCommands).toEqual(["pnpm preview reclaim --slot preview-1 --force"]);
    expect(diagnosis.reasons.some((reason) => reason.includes("closed/merged"))).toBe(true);
    expect(diagnosis.reasons.some((reason) => reason.includes("#2008"))).toBe(true);
    expect(diagnosis.reasons.some((reason) => reason.includes("#1983"))).toBe(true);
    expect(diagnosis.summary).toContain("orphaned");
  });
});

describe("durable preview stack records", () => {
  test("keeps an existing record idempotently", async () => {
    const semaphore = fakeSemaphore({
      list: vi.fn(async () => [{ slug: "preview-2" }]),
    });

    await ensurePreviewStackRecord({
      dopplerConfig: "preview_2",
      semaphore,
      slug: "preview-2",
    });

    expect(semaphore.add).not.toHaveBeenCalled();
  });

  test("deletes the record only after final destroy succeeds", async () => {
    const destroyEnvironment = vi.fn(async () => {});
    const semaphore = fakeSemaphore();

    await destroyPreviewStackAndDeleteRecord({
      destroyEnvironment,
      dopplerConfig: "preview_2",
      semaphore,
      slug: "preview-2",
    });

    expect(semaphore.add).toHaveBeenCalledOnce();
    expect(semaphore.delete).toHaveBeenCalledExactlyOnceWith({
      slug: "preview-2",
      type: "preview-stack",
    });
    expect(destroyEnvironment.mock.invocationCallOrder[0]).toBeLessThan(
      semaphore.delete.mock.invocationCallOrder[0] as number,
    );
  });

  test("retains the record when final destroy fails", async () => {
    const destroyEnvironment = vi.fn(async () => {
      throw new Error("Cloudflare 429");
    });
    const semaphore = fakeSemaphore();

    await expect(
      destroyPreviewStackAndDeleteRecord({
        destroyEnvironment,
        dopplerConfig: "preview_2",
        semaphore,
        slug: "preview-2",
      }),
    ).rejects.toThrow("Cloudflare 429");

    expect(semaphore.add).toHaveBeenCalledOnce();
    expect(semaphore.delete).not.toHaveBeenCalled();
  });
});

describe("preview stack GC selection", () => {
  const now = 1_000_000_000_000;

  test("selects recorded stacks only when their environment lease is available or expired", () => {
    const selected = selectPreviewStacksForGc(
      [{ slug: "preview-1" }, { slug: "preview-2" }, { slug: "preview-3" }],
      [
        {
          slug: "preview-1",
          leaseState: "leased",
          leasedUntil: now + 60_000,
          holder: "pr-1",
        },
        {
          slug: "preview-2",
          leaseState: "leased",
          leasedUntil: now - 60_000,
          holder: "pr-2",
        },
        {
          slug: "preview-3",
          leaseState: "available",
          leasedUntil: null,
          holder: null,
        },
      ],
      now,
    );

    expect(selected).toEqual([
      { dopplerConfig: "preview_2", holder: "pr-2", slug: "preview-2" },
      { dopplerConfig: "preview_3", holder: null, slug: "preview-3" },
    ]);
  });

  test("rejects a stack record outside the canonical preview inventory", () => {
    expect(() =>
      selectPreviewStacksForGc(
        [{ slug: "preview-99" }],
        [{ slug: "preview-99", leaseState: "available", leasedUntil: null, holder: null }],
        now,
      ),
    ).toThrow("unknown preview slot preview-99");
  });

  test("rejects a recorded stack without lease inventory", () => {
    expect(() => selectPreviewStacksForGc([{ slug: "preview-2" }], [], now)).toThrow(
      "no environment lease inventory",
    );
  });
});

describe("destructive lease reclaim", () => {
  const orphaned = {
    holder: "pr-1580",
    lastUsedAgo: "1m ago",
    leasedUntil: "2026-07-14T12:00:00.000Z",
    pullRequestUrl: "https://github.com/iterate/iterate/pull/1580",
    slug: "preview-2",
    verdict: "orphaned" as const,
  };

  test("requires explicit force even when the holder PR is closed", () => {
    expect(() => requireExplicitReclaimForce(orphaned, undefined)).toThrow(
      /may race its owner's deploy or close-triggered cleanup/,
    );
  });

  test("allows a verified operator takeover", () => {
    expect(() => requireExplicitReclaimForce(orphaned, true)).not.toThrow();
  });
});

describe("lease ownership during acquire", () => {
  function conflictError() {
    const error = new Error("No resource is currently available for this type.");
    (error as Error & { code: string }).code = "CONFLICT";
    return error;
  }

  test("never force-acquires a held slot while its owner may be cleaning it up", async () => {
    const destroyEnvironment = vi.fn(async () => {});
    const acquireSpecific = vi.fn();
    const semaphore = fakeSemaphore({
      acquire: vi.fn(async () => {
        throw conflictError();
      }),
      acquireSpecific,
    });

    await expect(
      acquireAnyEnvironmentConfigLease({
        destroyEnvironment,
        semaphore,
        holder: "pr-1600",
        leaseMs: 1000,
        waitTotalMs: 0,
      }),
    ).rejects.toThrow(/Automation never force-reclaims a held slot/);

    expect(acquireSpecific).not.toHaveBeenCalled();
    expect(destroyEnvironment).not.toHaveBeenCalled();
  });

  test("records then destroys a freshly acquired environment before handover", async () => {
    const destroyEnvironment = vi.fn(async () => {});
    const acquire = vi.fn(async () =>
      fakeLease({ slug: "preview-7", data: { dopplerConfig: "preview_seven" } }),
    );
    const semaphore = fakeSemaphore({ acquire });

    const lease = await acquireAnyEnvironmentConfigLease({
      destroyEnvironment,
      semaphore,
      holder: "pr-1600",
      leaseMs: 1000,
      waitTotalMs: 0,
    });

    expect(lease.slug).toBe("preview-7");
    expect(destroyEnvironment).toHaveBeenCalledExactlyOnceWith({
      dopplerConfig: "preview_seven",
      slug: "preview-7",
    });
    expect(semaphore.add).toHaveBeenCalledExactlyOnceWith({
      data: { dopplerConfig: "preview_seven" },
      slug: "preview-7",
      type: "preview-stack",
    });
    expect(semaphore.add.mock.invocationCallOrder[0]).toBeLessThan(
      destroyEnvironment.mock.invocationCallOrder[0] as number,
    );
  });
});

describe("cleanup lease release", () => {
  const lease = { type: "environment-config", slug: "preview-4", leaseId: "lease-1950" };

  test("releases the lease even when teardown failed — the stack record remains for GC", async () => {
    // 2026-07-14 incident: a Cloudflare 429 failed teardown mid-cleanup and
    // the old code bailed before releasing; the merged PR's lease leaked for
    // 24h and starved the fleet. The cleanup obligation now outlives the lease.
    const release = vi.fn(async () => ({ released: true }));
    const semaphore = fakeSemaphore({ release });

    const result = await releaseLeaseDespiteTeardownFailure({
      lease,
      semaphore,
      teardownOk: false,
    });

    expect(result).toEqual({ ok: true, released: true });
    expect(release).toHaveBeenCalledExactlyOnceWith({
      type: "environment-config",
      slug: "preview-4",
      leaseId: "lease-1950",
    });
  });

  test("treats an already-gone lease as a successful (non-)release", async () => {
    const semaphore = fakeSemaphore({ release: vi.fn(async () => ({ released: false })) });

    const result = await releaseLeaseDespiteTeardownFailure({
      lease,
      semaphore,
      teardownOk: true,
    });

    expect(result).toEqual({ ok: true, released: false });
  });

  test("reports ok=false only when the release call itself fails — that is the real leak", async () => {
    const semaphore = fakeSemaphore({
      release: vi.fn(async () => {
        throw new Error("semaphore unreachable");
      }),
    });

    const result = await releaseLeaseDespiteTeardownFailure({
      lease,
      semaphore,
      teardownOk: false,
    });

    expect(result).toEqual({ ok: false, released: false });
  });
});

describe("assignEnvironmentConfigLease", () => {
  const { assignEnvironmentConfigLease } = previewInternals;

  test("keeps (and renews via re-issue) the held slot when no specific slot is requested", async () => {
    const semaphore = fakeSemaphore({
      acquireSpecific: vi.fn(async () => fakeLease({ expiresAt: 1_800_000_000_000 })),
      list: vi.fn(async () => [leasedResource("preview-2", "pr-1600")]),
    });

    const result = await assignEnvironmentConfigLease({
      destroyEnvironment: noopDestroyPreviewEnvironment,
      holder: "pr-1600",
      leaseMs: 1000,
      recordedSlug: "preview-2",
      semaphore,
      wantedSlug: null,
    });

    expect(result.outcome).toBe("kept");
    expect(result.lease.slug).toBe("preview-2");
    expect(result.changedFromSlug).toBeNull();
    expect(semaphore.acquire).not.toHaveBeenCalled();
  });

  test("keeps the held slot when it is the one requested", async () => {
    const semaphore = fakeSemaphore({
      acquireSpecific: vi.fn(async () => fakeLease()),
      list: vi.fn(async () => [leasedResource("preview-2", "pr-1600")]),
    });

    const result = await assignEnvironmentConfigLease({
      destroyEnvironment: noopDestroyPreviewEnvironment,
      holder: "pr-1600",
      leaseMs: 1000,
      recordedSlug: "preview-2",
      semaphore,
      wantedSlug: "preview-2",
    });

    expect(result.outcome).toBe("kept");
    // Exactly the adoption re-issue — no second acquire for the wanted slug.
    expect(semaphore.acquireSpecific).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ slug: "preview-2", force: true }),
    );
  });

  test("destroys an adopted requested slot when it is not recorded by the PR", async () => {
    const destroyEnvironment = vi.fn(async () => {});
    const semaphore = fakeSemaphore({
      acquireSpecific: vi.fn(async () =>
        fakeLease({ slug: "preview-17", data: { dopplerConfig: "preview_17" } }),
      ),
      list: vi.fn(async () => [leasedResource("preview-17", "pr-1600", "preview_17")]),
    });

    const result = await assignEnvironmentConfigLease({
      destroyEnvironment,
      holder: "pr-1600",
      leaseMs: 1000,
      recordedSlug: null,
      semaphore,
      wantedSlug: "preview-17",
    });

    expect(result).toMatchObject({
      outcome: "kept",
      lease: { slug: "preview-17" },
    });
    expect(destroyEnvironment).toHaveBeenCalledExactlyOnceWith({
      dopplerConfig: "preview_17",
      slug: "preview-17",
    });
  });

  test("moves to the requested slot and releases the previously held lease", async () => {
    const release = vi.fn(async () => ({ released: true }));
    const semaphore = fakeSemaphore({
      acquireSpecific: vi.fn(async (input: { slug: string }) =>
        input.slug === "preview-2"
          ? fakeLease({ leaseId: "9d975621-72c8-459d-936d-e9b4335e0f5d" })
          : fakeLease({
              slug: "preview-5",
              data: { dopplerConfig: "preview_5" },
              leaseId: "1197a5b3-a705-4380-9958-6a0dbead16b7",
            }),
      ),
      list: vi.fn(async () => [leasedResource("preview-2", "pr-1600")]),
      release,
    });

    const result = await assignEnvironmentConfigLease({
      destroyEnvironment: noopDestroyPreviewEnvironment,
      holder: "pr-1600",
      leaseMs: 1000,
      recordedSlug: "preview-2",
      semaphore,
      wantedSlug: "preview-5",
    });

    expect(result.outcome).toBe("moved");
    expect(result.lease.slug).toBe("preview-5");
    expect(result.changedFromSlug).toBe("preview-2");
    expect(result.previousLeaseReleased).toBe(true);
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "preview-2",
        leaseId: "9d975621-72c8-459d-936d-e9b4335e0f5d",
      }),
    );
  });

  test("finishes an interrupted requested-slot move when the holder owns both slots", async () => {
    const release = vi.fn(async () => ({ released: true }));
    const acquireSpecific = vi.fn(async (input: { force?: boolean; slug: string }) => {
      if (input.slug === "preview-2") {
        return fakeLease({
          slug: "preview-2",
          leaseId: "9d975621-72c8-459d-936d-e9b4335e0f5d",
        });
      }
      return input.force
        ? fakeLease({
            slug: "preview-17",
            data: { dopplerConfig: "preview_17" },
            leaseId: "1197a5b3-a705-4380-9958-6a0dbead16b7",
          })
        : null;
    });
    const semaphore = fakeSemaphore({
      acquireSpecific,
      list: vi.fn(async () => [
        leasedResource("preview-2", "pr-1600"),
        leasedResource("preview-17", "pr-1600", "preview_17"),
      ]),
      release,
    });

    const result = await assignEnvironmentConfigLease({
      destroyEnvironment: noopDestroyPreviewEnvironment,
      holder: "pr-1600",
      leaseMs: 1000,
      recordedSlug: "preview-2",
      semaphore,
      wantedSlug: "preview-17",
    });

    expect(result).toMatchObject({
      changedFromSlug: "preview-2",
      lease: { slug: "preview-17" },
      outcome: "moved",
      previousLeaseReleased: true,
    });
    expect(acquireSpecific).toHaveBeenCalledWith(
      expect.objectContaining({ force: true, slug: "preview-17" }),
    );
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseId: "9d975621-72c8-459d-936d-e9b4335e0f5d",
        slug: "preview-2",
      }),
    );
  });

  test("reports broken ownership when re-acquiring the same slug after losing it", async () => {
    // The semaphore attributes the slot to someone else, and the non-force
    // re-take fails; --force re-takes the SAME slug. Outcome must not be
    // "kept" — the interim holder may have deployed over this PR's apps.
    const acquireSpecific = vi.fn(async (input: { force?: boolean }) =>
      input.force ? fakeLease({ leaseId: "1197a5b3-a705-4380-9958-6a0dbead16b7" }) : null,
    );
    const semaphore = fakeSemaphore({
      acquireSpecific,
      list: vi.fn(async () => [leasedResource("preview-2", "pr-1601")]),
    });

    const result = await assignEnvironmentConfigLease({
      destroyEnvironment: noopDestroyPreviewEnvironment,
      force: true,
      holder: "pr-1600",
      leaseMs: 1000,
      recordedSlug: "preview-2",
      semaphore,
      wantedSlug: "preview-2",
    });

    expect(result.outcome).toBe("assigned");
    expect(result.lease.slug).toBe("preview-2");
    expect(result.changedFromSlug).toBeNull();
    expect(result.stackWasDestroyed).toBe(true);
  });

  test("explains who holds a requested slot instead of taking it without --force", async () => {
    const semaphore = fakeSemaphore({
      list: vi.fn(async () => [leasedResource("preview-5", "pr-1601")]),
    });

    await expect(
      assignEnvironmentConfigLease({
        destroyEnvironment: noopDestroyPreviewEnvironment,
        holder: "pr-1600",
        leaseMs: 1000,
        recordedSlug: null,
        semaphore,
        wantedSlug: "preview-5",
      }),
    ).rejects.toThrow(/pr-1601[\s\S]*--force/);
  });

  test("releases an unrelated adopted lease when the requested slot is unavailable", async () => {
    const release = vi.fn(async () => ({ released: true }));
    const semaphore = fakeSemaphore({
      acquireSpecific: vi.fn(async (input: { force?: boolean; slug: string }) =>
        input.slug === "preview-2" && input.force
          ? fakeLease({
              slug: "preview-2",
              leaseId: "9d975621-72c8-459d-936d-e9b4335e0f5d",
            })
          : null,
      ),
      list: vi.fn(async () => [
        leasedResource("preview-2", "pr-1600"),
        leasedResource("preview-5", "pr-1601"),
      ]),
      release,
    });

    await expect(
      assignEnvironmentConfigLease({
        destroyEnvironment: noopDestroyPreviewEnvironment,
        holder: "pr-1600",
        leaseMs: 1000,
        recordedSlug: null,
        semaphore,
        wantedSlug: "preview-5",
      }),
    ).rejects.toThrow(/preview-5 is leased by pr-1601/);
    expect(release).toHaveBeenCalledWith({
      leaseId: "9d975621-72c8-459d-936d-e9b4335e0f5d",
      slug: "preview-2",
      type: "environment-config-lease",
    });
  });

  test("keeps the recorded current lease when the requested slot is unavailable", async () => {
    const release = vi.fn(async () => ({ released: true }));
    const semaphore = fakeSemaphore({
      acquireSpecific: vi.fn(async (input: { force?: boolean; slug: string }) =>
        input.slug === "preview-2" && input.force
          ? fakeLease({
              slug: "preview-2",
              leaseId: "9d975621-72c8-459d-936d-e9b4335e0f5d",
            })
          : null,
      ),
      list: vi.fn(async () => [
        leasedResource("preview-2", "pr-1600"),
        leasedResource("preview-5", "pr-1601"),
      ]),
      release,
    });

    await expect(
      assignEnvironmentConfigLease({
        destroyEnvironment: noopDestroyPreviewEnvironment,
        holder: "pr-1600",
        leaseMs: 1000,
        recordedSlug: "preview-2",
        semaphore,
        wantedSlug: "preview-5",
      }),
    ).rejects.toThrow(/preview-5 is leased by pr-1601/);
    expect(release).not.toHaveBeenCalled();
  });

  test("passes force through to evict the current holder", async () => {
    const acquireSpecific = vi.fn(async () =>
      fakeLease({ slug: "preview-5", data: { dopplerConfig: "preview_5" } }),
    );
    const semaphore = fakeSemaphore({ acquireSpecific });

    const result = await assignEnvironmentConfigLease({
      destroyEnvironment: noopDestroyPreviewEnvironment,
      force: true,
      holder: "pr-1600",
      leaseMs: 1000,
      recordedSlug: null,
      semaphore,
      wantedSlug: "preview-5",
    });

    expect(result.outcome).toBe("assigned");
    expect(acquireSpecific).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
  });

  test("destroys the wanted environment on handover — including a --force eviction", async () => {
    const destroyEnvironment = vi.fn(async () => {});
    const semaphore = fakeSemaphore({
      acquireSpecific: vi.fn(async () =>
        fakeLease({ slug: "preview-5", data: { dopplerConfig: "preview_five" } }),
      ),
    });

    const result = await assignEnvironmentConfigLease({
      destroyEnvironment,
      force: true,
      holder: "pr-1600",
      leaseMs: 1000,
      recordedSlug: null,
      semaphore,
      wantedSlug: "preview-5",
    });

    expect(result.lease.slug).toBe("preview-5");
    expect(destroyEnvironment).toHaveBeenCalledExactlyOnceWith({
      dopplerConfig: "preview_five",
      slug: "preview-5",
    });
  });

  test("a failed destroy keeps the stack record, gives the lease back, and throws", async () => {
    const destroyEnvironment = vi.fn(async () => {
      throw new Error("doppler exploded");
    });
    const release = vi.fn(async () => ({ released: true }));
    const semaphore = fakeSemaphore({
      acquireSpecific: vi.fn(async () =>
        fakeLease({ slug: "preview-5", leaseId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }),
      ),
      release,
    });

    await expect(
      assignEnvironmentConfigLease({
        destroyEnvironment,
        holder: "pr-1600",
        leaseMs: 1000,
        recordedSlug: null,
        semaphore,
        wantedSlug: "preview-5",
      }),
    ).rejects.toThrow(/Destroying preview-5 failed/);
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "preview-5",
        leaseId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      }),
    );
    expect(semaphore.add).toHaveBeenCalledOnce();
    expect(semaphore.delete).not.toHaveBeenCalled();
  });
});
