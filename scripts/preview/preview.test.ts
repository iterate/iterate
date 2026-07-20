import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  CloudflarePreviewAppEntry,
  CloudflarePreviewSlotDisplay,
  cloudflarePreviewApps,
  cloudflarePreviewAdditionalTriggerPaths,
  cloudflarePreviewSharedPaths,
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
  adoptLeaseHeldBySemaphore,
  claimEnvironmentConfigLease,
  describeForcePushCompareHazard,
  describeLostSlotOwnership,
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
  readPreviewAppConfig,
  reconcileEnvironmentConfigLeaseResources,
  releaseLeaseDespiteTeardownFailure,
  renderCloudflarePreviewPullRequestBody,
  resolveAuthPreviewRootSecret,
  resolvePreviewCompareBaseSha,
  resolvePreviewReadinessUrls,
  resolvePreviewTestBaseUrlEnvironment,
  selectExpiredLeasesForGc,
  selectPreviewAppsForPullRequest,
  selectPreviewAppsNeedingRetry,
  selectPreviewSlotDataOwners,
  splitRepositoryFullName,
  syncPreviewInventory,
  waitForHttpReadiness,
} = previewInternals;

describe("preview app dependency expansion", () => {
  test("expands os to include its auth and dummy-petshop dependencies", () => {
    expect(expandPreviewDependencies(["os"])).toEqual(["os", "auth", "dummy-petshop"]);
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

  test("deduplicates dependencies", () => {
    expect(expandPreviewDependencies(["os", "os", "auth"])).toEqual([
      "os",
      "auth",
      "dummy-petshop",
    ]);
  });
});

test("preview handover erases every app with slot-persistent data", () => {
  expect(selectPreviewSlotDataOwners().map((app) => app.slug)).toEqual([
    "os",
    "streams-example-app",
  ]);
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
        cloudflarePreviewApps.auth,
        cloudflarePreviewApps["dummy-petshop"],
      ]).map((batch) => batch.map((app) => app.slug)),
    ).toEqual([["os", "auth", "dummy-petshop"]]);
  });

  test("deploys the whole selected fleet in one batch", () => {
    expect(
      orderPreviewDeployBatches([
        cloudflarePreviewApps.os,
        cloudflarePreviewApps.semaphore,
        cloudflarePreviewApps["streams-example-app"],
        cloudflarePreviewApps.auth,
        cloudflarePreviewApps["dummy-petshop"],
      ]).map((batch) => batch.map((app) => app.slug)),
    ).toEqual([["os", "semaphore", "streams-example-app", "auth", "dummy-petshop"]]);
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

  test("runs the auth OAuth provider e2e against its deployed preview", () => {
    // The auth lane runs the full apps/auth/e2e suite (authorize → code →
    // token exchange), not a discovery curl: a bare metadata probe is what
    // let the 2026-07-11 streams.iterate.com stale-registration incident
    // ship silently (docs/testing.md#lanes).
    expect(cloudflarePreviewApps.auth).toMatchObject({
      appPath: "apps/auth",
      previewReadyUrlPath: "/api/auth/ok",
      previewTestBaseUrlEnvVar: "AUTH_BASE_URL",
      previewTestCommandArgs: ["pnpm", "test:e2e"],
    });
  });

  test("runs the dummy-petshop live e2e against its deployed preview", async () => {
    const petshop = cloudflarePreviewApps["dummy-petshop"];

    expect(petshop).toMatchObject({
      appPath: "apps/dummy-petshop",
      paths: ["apps/dummy-petshop/**"],
      previewReadyUrlPath: "/",
      previewTestBaseUrlEnvVar: "PETSHOP_BASE_URL",
      previewTestCommandArgs: ["pnpm", "test:e2e"],
    });
    await expect(
      readPreviewAppConfig({
        app: petshop,
        commandEnvironment: {},
        dopplerConfig: "preview_3",
        repositoryRoot: repoRoot,
      }),
    ).resolves.toEqual({
      baseUrl: "https://dummy-petshop.iterate-preview-3.com",
      projectHostnameBases: [],
    });
    // Only the deploy workflow is path-filtered; cleanup deliberately has no
    // paths list (it must run for every closed PR — see the cleanup-trigger
    // test below), so it is not asserted here.
    expect(
      readFileSync(resolve(repoRoot, ".depot/workflows/cloudflare-previews.yml"), "utf8"),
    ).toContain("- apps/dummy-petshop/**");
  });

  test("deploys OS after Petshop and passes that exact preview URL to OS e2e", () => {
    const headSha = "abc1234";
    const os = cloudflarePreviewApps.os;

    expect(os).toMatchObject({
      paths: expect.arrayContaining([
        ".bun-version",
        "apps/dummy-petshop/**",
        "apps/mobile/**",
        "playwright.config.ts",
        "packages/iterate/**",
        "specs/**",
      ]),
      previewDependencies: ["auth", "dummy-petshop"],
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
      readFileSync(resolve(repoRoot, ".depot/workflows/cloudflare-previews.yml"), "utf8"),
    ).toContain("bun-version-file: .bun-version");
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
        headSha,
      }),
    ).toEqual([
      "OS_BASE_URL=https://os.iterate-preview-7.com",
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

    expect(apps.map((app) => app.slug)).toEqual(["os", "auth", "dummy-petshop"]);
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
        headSha: "current-head",
      }),
    ).toThrow(/PETSHOP_BASE_URL requires dummy-petshop deployed at head current/);
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

  test("sweeps expired leases on a schedule from default-branch tooling", () => {
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
    // Runs current tooling, and needs no GitHub token — lease expiry is the
    // only signal.
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
  });

  test("normalizes marathon artifacts before Depot upload", () => {
    const workflow = readFileSync(
      resolve(repoRoot, ".depot/workflows/preview-e2e-marathon.yml"),
      "utf8",
    );

    expect(workflow).toContain("scripts/preview/collect-test-artifacts.sh test-results");
    expect(workflow).toContain("path: test-results");
    expect(workflow).toContain("include-hidden-files: true");
    expect(workflow).not.toContain("            /tmp/os-e2e-*");
    expect(workflow).not.toContain("            /tmp/marathon");
  });

  test("starts every isolated OS sub-lane in parallel", () => {
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
    expect(script).toContain("env PLAYWRIGHT_PREVIEW_SLOW_FIRST=1");
    expect(script).toContain('wait "$PW_INSTALL_PID"');
    expect(script).toContain("SMOKE_PID");
    expect(script).toContain("TUI_PID");
    expect(script).toContain("E2E_PID");
    expect(script).toContain('wait "$SMOKE_PID"');
    expect(script).toContain('wait "$TUI_PID"');
    expect(script).toContain('wait "$E2E_PID"');
    expect(script).toContain('[ "$SMOKE_OK" -eq 0 ]');
    expect(script).toContain('[ "$TUI_OK" -eq 0 ]');
    expect(script).toContain('[ "$E2E_OK" -eq 0 ]');
    // Each background lane starts before any join. Playwright starts as soon
    // as Chromium is ready while those remote lanes are still running.
    for (const lane of [smokeLane, tuiLane, e2eLane]) {
      expect(script.indexOf(lane)).toBeLessThan(script.indexOf('wait "$PW_INSTALL_PID"'));
    }
    expect(script.indexOf('wait "$PW_INSTALL_PID"')).toBeLessThan(script.indexOf(playwrightSpec));
    expect(script.indexOf(playwrightSpec)).toBeLessThan(script.indexOf('wait "$E2E_PID"'));
  });

  test("guards the parallel OS preview lane with target budgets", () => {
    expect(cloudflarePreviewApps.os).toMatchObject({
      previewDeployBudgetMs: 90_000,
      previewTestBudgetMs: 100_000,
    });

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

  test("requires the expected worker version to remain stable before declaring readiness", async () => {
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
        workerVersion: { expected: "expected-version", stableForMs: 2_000 },
      });

      await vi.advanceTimersByTimeAsync(3_000);
      await expect(readiness).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(4);
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
      expected: ["os", "auth", "dummy-petshop"],
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
      expected: ["os", "auth", "dummy-petshop"],
    },
    {
      // An awaiting-tests entry at any head is a deploy whose tests never ran
      // (a cancelled run). Redeploying it at the current head is idempotent
      // and is what keeps `test`'s "no app recorded at this head" skip honest
      // (observed 2026-07-10: a cancelled run's deploy landed, the next
      // push's non-app diff selected nothing, and the check went green over
      // deployments that never passed tests).
      name: "re-runs awaiting-tests apps whatever head deployed them — their e2e never ran",
      recorded: {
        appDisplayName: "OS",
        appSlug: "os",
        headSha: "old-head",
        status: "awaiting-tests" as const,
      },
      expected: ["os", "auth", "dummy-petshop"],
    },
  ])("$name", ({ recorded, expected }) => {
    expect(
      selectPreviewAppsNeedingRetry({
        previousState: {
          apps: {
            [recorded.appSlug]: { ...recorded, updatedAt: "2026-05-01T00:00:00.000Z" },
          },
          environmentConfigLease: null,
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
    return CloudflarePreviewAppEntry.parse({
      appDisplayName: displayName,
      appSlug: slug,
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
        environmentConfigLease: null,
        notice: null,
      },
      fetchCompare: compareMustNotRun,
      probeAppServing: everythingServing,
    });

    expect(apps).toEqual([]);
  });

  test("selects OS and its dependencies for an iterate TUI-only change", async () => {
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

    expect(apps.map((app) => app.slug)).toEqual(["os", "auth", "dummy-petshop"]);
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
      "semaphore",
      "auth",
      "streams-example-app",
      "dummy-petshop",
    ]);
  });

  test("self-heals an erased slot: a parked recorded-green app is redeployed with its dependencies", async () => {
    // Live incident (PR #1793 on preview-7, 2026-07-09): e2e failed with
    // "no such column: epoch", the documented remedy `erase-data` parked the
    // os worker (503) and wiped auth's D1 (OAuth clients), but os and auth
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
        environmentConfigLease: null,
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

    expect(apps.map((app) => app.slug)).toEqual(["os", "semaphore", "auth", "dummy-petshop"]);
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
    acquire: vi.fn(async () => fakeLease()),
    acquireSpecific: vi.fn(async () => null),
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

// Every acquire path must be able to erase a reclaimed slot; tests that
// never reclaim share this inert eraser.
const noopEraseSlotData = async () => {};

describe("claimEnvironmentConfigLease", () => {
  test("adopts (and thereby renews) the slot the semaphore attributes to this holder", async () => {
    // The PR body's copy is never consulted for ownership: the semaphore says
    // pr-1600 holds preview-2, so the claim re-issues that lease. Matching
    // the recorded slug means the slot carries this PR's own deployment — no
    // erase.
    const eraseSlotData = vi.fn(async () => {});
    const semaphore = fakeSemaphore({
      acquireSpecific: vi.fn(async () => fakeLease({ expiresAt: 1_800_000_000_000 })),
      list: vi.fn(async () => [leasedResource("preview-2", "pr-1600")]),
    });

    const lease = await claimEnvironmentConfigLease({
      eraseSlotData,
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
    expect(eraseSlotData).not.toHaveBeenCalled();
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

    const lease = await claimEnvironmentConfigLease({
      eraseSlotData: noopEraseSlotData,
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

    const lease = await claimEnvironmentConfigLease({
      eraseSlotData: noopEraseSlotData,
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
  });

  test("moves to a fresh slot when someone else now holds the recorded one", async () => {
    const semaphore = fakeSemaphore({
      acquire: vi.fn(async () =>
        fakeLease({ slug: "preview-5", data: { dopplerConfig: "preview_5" } }),
      ),
      list: vi.fn(async () => [leasedResource("preview-2", "pr-1601")]),
    });

    const lease = await claimEnvironmentConfigLease({
      eraseSlotData: noopEraseSlotData,
      holder: "pr-1600",
      leaseMs: 1000,
      recordedSlug: "preview-2",
      semaphore,
      waitTotalMs: 0,
    });

    expect(lease.slug).toBe("preview-5");
    expect(lease.dopplerConfig).toBe("preview_5");
    expect(semaphore.acquire).toHaveBeenCalledWith(expect.objectContaining({ holder: "pr-1600" }));
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

    const lease = await claimEnvironmentConfigLease({
      eraseSlotData: noopEraseSlotData,
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

  test("erases an adopted slot that is not the PR body's recorded one", async () => {
    // The adopted lease exists precisely because a previous run died before
    // recording it — possibly mid-erase — so its provenance is unknown.
    const eraseSlotData = vi.fn(async () => {});
    const semaphore = fakeSemaphore({
      acquireSpecific: vi.fn(async () =>
        fakeLease({ slug: "preview-3", data: { dopplerConfig: "preview_three" } }),
      ),
      list: vi.fn(async () => [leasedResource("preview-3", "pr-1600", "preview_three")]),
    });

    const lease = await claimEnvironmentConfigLease({
      eraseSlotData,
      holder: "pr-1600",
      leaseMs: 1000,
      recordedSlug: null,
      semaphore,
      waitTotalMs: 0,
    });

    expect(lease.slug).toBe("preview-3");
    expect(eraseSlotData).toHaveBeenCalledExactlyOnceWith({
      dopplerConfig: "preview_three",
      slug: "preview-3",
    });
  });

  test("propagates unexpected semaphore errors instead of silently switching slots", async () => {
    const semaphore = fakeSemaphore({
      list: vi.fn(async () => {
        throw new Error("semaphore is down");
      }),
    });

    await expect(
      claimEnvironmentConfigLease({
        eraseSlotData: noopEraseSlotData,
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
      eraseSlotData: noopEraseSlotData,
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
        eraseSlotData: noopEraseSlotData,
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
        eraseSlotData: noopEraseSlotData,
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

describe("gc expired-lease selection", () => {
  const now = 1_000_000_000_000;
  const base = { data: {}, lastReleasedAt: null, lastAcquiredAt: null };

  test("selects only leased slots whose lease is at or past expiry", () => {
    const selected = selectExpiredLeasesForGc(
      [
        // Live lease — a PR is still using it, skip.
        {
          ...base,
          slug: "preview-1",
          leaseState: "leased",
          leasedUntil: now + 60_000,
          holder: "pr-1",
        },
        // Expired lease — reclaim.
        {
          ...base,
          slug: "preview-2",
          leaseState: "leased",
          leasedUntil: now - 60_000,
          holder: "pr-2",
        },
        // Exactly at expiry — reclaim (<=).
        { ...base, slug: "preview-3", leaseState: "leased", leasedUntil: now, holder: "pr-3" },
        // Available slots are cleaned by their next acquirer, never by gc.
        { ...base, slug: "preview-4", leaseState: "available", leasedUntil: null, holder: null },
      ],
      now,
    );

    expect(selected.map((slot) => slot.slug)).toEqual(["preview-2", "preview-3"]);
  });

  test("resolves the doppler config from lease data, else derives it from the slug", () => {
    const selected = selectExpiredLeasesForGc(
      [
        {
          ...base,
          slug: "preview-5",
          leaseState: "leased",
          leasedUntil: now - 1,
          holder: "pr-5",
          data: { dopplerConfig: "preview_5" },
        },
        // No payload yet → slug-derived (preview-6 → preview_6).
        { ...base, slug: "preview-6", leaseState: "leased", leasedUntil: now - 1, holder: null },
      ],
      now,
    );

    expect(selected.map((slot) => slot.dopplerConfig)).toEqual(["preview_5", "preview_6"]);
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
    const eraseSlotData = vi.fn(async () => {});
    const acquireSpecific = vi.fn();
    const semaphore = fakeSemaphore({
      acquire: vi.fn(async () => {
        throw conflictError();
      }),
      acquireSpecific,
    });

    await expect(
      acquireAnyEnvironmentConfigLease({
        eraseSlotData,
        semaphore,
        holder: "pr-1600",
        leaseMs: 1000,
        waitTotalMs: 0,
      }),
    ).rejects.toThrow(/Automation never force-reclaims a held slot/);

    expect(acquireSpecific).not.toHaveBeenCalled();
    expect(eraseSlotData).not.toHaveBeenCalled();
  });

  test("erases a freshly acquired slot too — cleanliness is an entry invariant", async () => {
    // Plain acquire (no reclaim involved) must erase as well: exit paths like
    // lease expiry after a failed cleanup return dirty slots to the pool as
    // plain "available", and this is what makes them harmless.
    const eraseSlotData = vi.fn(async () => {});
    const acquire = vi.fn(async () =>
      fakeLease({ slug: "preview-7", data: { dopplerConfig: "preview_seven" } }),
    );
    const semaphore = fakeSemaphore({ acquire });

    const lease = await acquireAnyEnvironmentConfigLease({
      eraseSlotData,
      semaphore,
      holder: "pr-1600",
      leaseMs: 1000,
      waitTotalMs: 0,
    });

    expect(lease.slug).toBe("preview-7");
    expect(eraseSlotData).toHaveBeenCalledExactlyOnceWith({
      dopplerConfig: "preview_seven",
      slug: "preview-7",
    });
  });
});

describe("cleanup lease release", () => {
  const lease = { type: "environment-config", slug: "preview-4", leaseId: "lease-1950" };

  test("releases the lease even when teardown/erase failed — the slot is left dirty, not leaked", async () => {
    // 2026-07-14 incident: a Cloudflare 429 failed erase-data mid-cleanup and
    // the old code bailed before releasing; the merged PR's lease leaked for
    // 24h and starved the fleet. The dirty slot is the harmless half: every
    // acquire erases on entry (see the entry-invariant test above).
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
      eraseSlotData: noopEraseSlotData,
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
      eraseSlotData: noopEraseSlotData,
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
      eraseSlotData: noopEraseSlotData,
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
      eraseSlotData: noopEraseSlotData,
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
  });

  test("explains who holds a requested slot instead of taking it without --force", async () => {
    const semaphore = fakeSemaphore({
      list: vi.fn(async () => [leasedResource("preview-5", "pr-1601")]),
    });

    await expect(
      assignEnvironmentConfigLease({
        eraseSlotData: noopEraseSlotData,
        holder: "pr-1600",
        leaseMs: 1000,
        recordedSlug: null,
        semaphore,
        wantedSlug: "preview-5",
      }),
    ).rejects.toThrow(/pr-1601[\s\S]*--force/);
  });

  test("passes force through to evict the current holder", async () => {
    const acquireSpecific = vi.fn(async () =>
      fakeLease({ slug: "preview-5", data: { dopplerConfig: "preview_5" } }),
    );
    const semaphore = fakeSemaphore({ acquireSpecific });

    const result = await assignEnvironmentConfigLease({
      eraseSlotData: noopEraseSlotData,
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

  test("erases the wanted slot on handover — including a --force eviction", async () => {
    const eraseSlotData = vi.fn(async () => {});
    const semaphore = fakeSemaphore({
      acquireSpecific: vi.fn(async () =>
        fakeLease({ slug: "preview-5", data: { dopplerConfig: "preview_five" } }),
      ),
    });

    const result = await assignEnvironmentConfigLease({
      eraseSlotData,
      force: true,
      holder: "pr-1600",
      leaseMs: 1000,
      recordedSlug: null,
      semaphore,
      wantedSlug: "preview-5",
    });

    expect(result.lease.slug).toBe("preview-5");
    expect(eraseSlotData).toHaveBeenCalledExactlyOnceWith({
      dopplerConfig: "preview_five",
      slug: "preview-5",
    });
  });

  test("a failed erase on the wanted slot gives the lease back and throws", async () => {
    const eraseSlotData = vi.fn(async () => {
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
        eraseSlotData,
        holder: "pr-1600",
        leaseMs: 1000,
        recordedSlug: null,
        semaphore,
        wantedSlug: "preview-5",
      }),
    ).rejects.toThrow(/Erasing preview-5 failed/);
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "preview-5",
        leaseId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      }),
    );
  });
});
