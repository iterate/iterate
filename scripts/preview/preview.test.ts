import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  CloudflarePreviewAppEntry,
  EnvironmentConfigLease,
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
  assertPreviewAppConfigMatchesEnvironment,
  claimEnvironmentConfigLease,
  completeEnvironmentPreparation,
  describeForcePushCompareHazard,
  evaluateCloudflareZoneCheck,
  explainPreviewTestSkip,
  holderPullRequestUrl,
  isFullFleetDeploymentComplete,
  reassertEnvironmentConfigLease,
  requireExplicitReclaimForce,
  resolveSlotWaitTotalMs,
  expandPreviewDependencies,
  orderPreviewDeployBatches,
  planPreviewDeploymentAfterLeaseClaim,
  parseCloudflarePreviewState,
  parseEnvironmentConfigLeaseData,
  reconcileEnvironmentConfigLeaseResources,
  renderCloudflarePreviewPullRequestBody,
  resolveAuthPreviewRootSecret,
  resolvePreviewCompareBaseSha,
  resolvePreviewReadinessUrls,
  selectPreviewAppsForPullRequest,
  selectPreviewAppsNeedingRetry,
  splitRepositoryFullName,
  syncPreviewInventory,
} = previewInternals;

describe("preview test target trust boundary", () => {
  it("uses the OS base-url variable that carries its admin secret", () => {
    expect(cloudflarePreviewApps.os.previewTestBaseUrlEnvVar).toBe("APP_CONFIG_BASE_URL");
  });

  it("accepts the exact checked-in OS origin and project hostname base", () => {
    expect(
      assertPreviewAppConfigMatchesEnvironment({
        appSlug: "os",
        config: {
          baseUrl: "https://os.iterate-preview-2.com",
          projectHostnameBases: ["iterate-preview-2.app"],
        },
        dopplerConfig: "preview_2",
      }),
    ).toEqual({
      baseUrl: "https://os.iterate-preview-2.com",
      projectHostnameBases: ["iterate-preview-2.app"],
    });
  });

  it("rejects a repointed Doppler origin before secret-bearing tests", () => {
    expect(() =>
      assertPreviewAppConfigMatchesEnvironment({
        appSlug: "os",
        config: {
          baseUrl: "https://attacker.example",
          projectHostnameBases: ["iterate-preview-2.app"],
        },
        dopplerConfig: "preview_2",
      }),
    ).toThrow("envs.ts requires exact origin https://os.iterate-preview-2.com");
  });

  it("rejects a path on the otherwise correct origin", () => {
    expect(() =>
      assertPreviewAppConfigMatchesEnvironment({
        appSlug: "os",
        config: {
          baseUrl: "https://os.iterate-preview-2.com/forward",
          projectHostnameBases: ["iterate-preview-2.app"],
        },
        dopplerConfig: "preview_2",
      }),
    ).toThrow("requires exact origin");
  });

  it("rejects repointed OS project hostnames", () => {
    expect(() =>
      assertPreviewAppConfigMatchesEnvironment({
        appSlug: "os",
        config: {
          baseUrl: "https://os.iterate-preview-2.com",
          projectHostnameBases: ["attacker.example"],
        },
        dopplerConfig: "preview_2",
      }),
    ).toThrow("project hostname bases do not match envs.ts");
  });
});

describe("preview app dependency expansion", () => {
  it("expands os to include its auth dependency", () => {
    expect(expandPreviewDependencies(["os"])).toEqual(["os", "auth"]);
  });

  it("expands semaphore to include its auth dependency", () => {
    expect(expandPreviewDependencies(["semaphore"])).toEqual(["semaphore", "auth"]);
  });

  it("keeps independent apps as-is", () => {
    expect(expandPreviewDependencies(["streams-example-app"])).toEqual(["streams-example-app"]);
  });

  it("deduplicates dependencies", () => {
    expect(expandPreviewDependencies(["os", "os", "auth"])).toEqual(["os", "auth"]);
  });
});

describe("preview app selection after lease claim", () => {
  it("redeploys the complete fleet after a same-slot handover", () => {
    const selectedApps = [cloudflarePreviewApps.os];

    const plan = planPreviewDeploymentAfterLeaseClaim({
      preparationRequired: true,
      selectedApps,
    });

    expect(plan.apps.map((app) => app.slug).sort()).toEqual(
      Object.keys(cloudflarePreviewApps).sort(),
    );
  });

  it("redeploys the complete fleet while Semaphore records an unfinished handover", () => {
    const plan = planPreviewDeploymentAfterLeaseClaim({
      preparationRequired: true,
      selectedApps: [],
    });

    expect(plan.apps.map((app) => app.slug).sort()).toEqual(
      Object.keys(cloudflarePreviewApps).sort(),
    );
  });

  it("preserves diff selection only under exact lease continuity", () => {
    const selectedApps = [cloudflarePreviewApps.os];

    const plan = planPreviewDeploymentAfterLeaseClaim({
      preparationRequired: false,
      selectedApps,
    });

    expect(plan.apps).toBe(selectedApps);
  });

  it("completes a handover only when every app is awaiting tests at the same head", () => {
    const apps = Object.fromEntries(
      Object.values(cloudflarePreviewApps).map((app) => [
        app.slug,
        CloudflarePreviewAppEntry.parse({
          appDisplayName: app.displayName,
          appSlug: app.slug,
          headSha: "current-head",
          status: "awaiting-tests",
          updatedAt: "2026-07-13T00:00:00.000Z",
        }),
      ]),
    );

    expect(isFullFleetDeploymentComplete({ apps, pullRequestHeadSha: "current-head" })).toBe(true);
    expect(
      isFullFleetDeploymentComplete({
        apps: { ...apps, auth: { ...apps.auth, headSha: "old-head" } },
        pullRequestHeadSha: "current-head",
      }),
    ).toBe(false);
    expect(
      isFullFleetDeploymentComplete({
        apps: { ...apps, auth: { ...apps.auth, status: "deploy-failed" } },
        pullRequestHeadSha: "current-head",
      }),
    ).toBe(false);
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

  it("deploys auth before OS", () => {
    expect(
      orderPreviewDeployBatches([cloudflarePreviewApps.os, cloudflarePreviewApps.auth]).map(
        (batch) => batch.map((app) => app.slug),
      ),
    ).toEqual([["auth"], ["os"]]);
  });

  it("keeps auth dependents parallel after auth is ready", () => {
    expect(
      orderPreviewDeployBatches([
        cloudflarePreviewApps.os,
        cloudflarePreviewApps.semaphore,
        cloudflarePreviewApps.auth,
      ]).map((batch) => batch.map((app) => app.slug)),
    ).toEqual([["auth"], ["os", "semaphore"]]);
  });
});

describe("preview workflow scope", () => {
  it("includes shared preview orchestration paths", () => {
    expect(cloudflarePreviewSharedPaths).toContain("scripts/preview/**");
    expect(cloudflarePreviewSharedPaths).toContain("packages/ui/**");
    expect(cloudflarePreviewAdditionalTriggerPaths).toContain("apps/iterate-com/**");
    // The preview deploy + e2e lifecycle is one Depot CI workflow (cleanup
    // has its own, with mirrored paths); a change to it triggers a full-fleet
    // preview and must be mirrored in that file's own paths list.
    expect(cloudflarePreviewSharedPaths).toContain(".depot/workflows/cloudflare-previews.yml");
    // Dependency manifests can change every app's build output; a diff that
    // touches only them must select the full fleet, not "no apps affected"
    // (which strands the fleet's recorded heads behind the PR head).
    expect(cloudflarePreviewSharedPaths).toContain("pnpm-lock.yaml");
    expect(cloudflarePreviewSharedPaths).toContain("pnpm-workspace.yaml");
    expect(cloudflarePreviewSharedPaths).toContain("patches/**");
  });

  it("rejects pre-RPC branches before the preview orchestrator can deploy Auth", () => {
    const workflow = readFileSync(
      resolve(repoRoot, ".depot/workflows/cloudflare-previews.yml"),
      "utf8",
    );
    const epoch = readFileSync(resolve(repoRoot, "scripts/preview/deployment-epoch"), "utf8");

    expect(epoch.trim()).toBe("os-auth-rpc-v1");
    expect(workflow).toContain('expected="os-auth-rpc-v1"');
    expect(workflow.indexOf("Enforce preview deployment epoch")).toBeLessThan(
      workflow.indexOf("pnpm preview deploy"),
    );
  });

  it("serializes deploy and cleanup per PR without a fleet-wide maintenance gate", () => {
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
      "cancel-in-progress": false,
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
});

describe("draft preview policy", () => {
  const { decideDraftPreviewPolicy } = previewInternals;

  it("deploys ready PRs regardless of labels or leases", () => {
    expect(
      decideDraftPreviewPolicy({
        allowDraft: false,
        hasRecordedLease: false,
        isDraft: false,
        labels: [],
      }),
    ).toBe("deploy");
  });

  it("skips drafts that never had a slot", () => {
    expect(
      decideDraftPreviewPolicy({
        allowDraft: false,
        hasRecordedLease: false,
        isDraft: true,
        labels: ["bug"],
      }),
    ).toBe("skip");
  });

  it("gives a draft's slot back when it holds one without asking", () => {
    expect(
      decideDraftPreviewPolicy({
        allowDraft: false,
        hasRecordedLease: true,
        isDraft: true,
        labels: [],
      }),
    ).toBe("teardown");
  });

  it("deploys drafts wearing the preview label", () => {
    expect(
      decideDraftPreviewPolicy({
        allowDraft: false,
        hasRecordedLease: false,
        isDraft: true,
        labels: ["preview"],
      }),
    ).toBe("deploy");
  });

  it("deploys drafts when the caller explicitly allows it", () => {
    expect(
      decideDraftPreviewPolicy({
        allowDraft: true,
        hasRecordedLease: false,
        isDraft: true,
        labels: [],
      }),
    ).toBe("deploy");
  });

  it("wires the lifecycle events and the dispatch override into the workflow", () => {
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
    // A manual dispatch is an explicit ask, so it bypasses the draft policy.
    expect(workflow).toContain(
      "${{ github.event_name == 'workflow_dispatch' && '--allow-draft' || '' }}",
    );
  });
});

describe("auth preview root secrets", () => {
  it("seeds from auth/dev when the preview root has no value", () => {
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

  it("keeps an existing preview root value ahead of the dev fallback", () => {
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
  it("uploads Playwright and Vitest artifacts for OS preview failures", () => {
    expect(cloudflarePreviewApps.os).toMatchObject({
      previewTestArtifacts: ["test-results", "apps/os/test-results", "/tmp/os-e2e-*"],
    });
  });

  it("normalizes OS preview artifacts before Depot upload", () => {
    const workflow = readFileSync(
      resolve(repoRoot, ".depot/workflows/cloudflare-previews.yml"),
      "utf8",
    );

    expect(workflow).toContain("scripts/preview/collect-test-artifacts.sh test-results");
    expect(workflow).toContain("path: test-results");
    expect(workflow).toContain("include-hidden-files: true");
    expect(workflow).not.toContain("            /tmp/os-e2e-*");
  });

  it("normalizes marathon artifacts before Depot upload", () => {
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

  it("runs the OS vitest node project concurrently with the root Playwright specs", () => {
    const script = cloudflarePreviewApps.os.previewTestCommandArgs[2];
    const playwrightInstall = "pnpm --dir ../.. exec playwright install chromium";
    // The chromium install starts first in the background; the single vitest
    // lane (node project) runs in a background subshell concurrently with the
    // foreground Playwright specs; the waits propagate their exit codes.
    const e2eLane = "pnpm e2e --project node >";
    const playwrightSpec = "pnpm --dir ../.. spec";

    expect(script).toContain(playwrightInstall);
    expect(script).toContain(e2eLane);
    expect(script).toContain(playwrightSpec);
    expect(script).toContain('wait "$PW_INSTALL_PID"');
    expect(script).toContain('wait "$E2E_PID"');
    expect(script).toContain('[ "$E2E_OK" -eq 0 ]');
    // Install kicks off before the lane and completes (wait) before the specs.
    expect(script.indexOf(playwrightInstall)).toBeLessThan(script.indexOf(e2eLane));
    expect(script.indexOf(e2eLane)).toBeLessThan(script.indexOf(playwrightSpec));
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
          notice: null,
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
          notice: null,
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
          notice: null,
        },
        pullRequestHeadSha: "current-head",
      }).map((app) => app.slug),
    ).toEqual(["os", "auth"]);
  });

  it("retries apps whose slot claim failed", () => {
    expect(
      selectPreviewAppsNeedingRetry({
        previousState: {
          apps: {
            semaphore: {
              appDisplayName: "Semaphore",
              appSlug: "semaphore",
              headSha: "current-head",
              status: "claim-failed",
              updatedAt: "2026-05-01T00:00:00.000Z",
            },
          },
          environmentConfigLease: null,
          notice: null,
        },
        pullRequestHeadSha: "current-head",
      }).map((app) => app.slug),
      // Semaphore's retry pulls in its auth dependency (relying-party JWKS).
    ).toEqual(["semaphore", "auth"]);
  });

  it("retries failed apps from older commits so a diff-miss push cannot leave the slot wedged", () => {
    // Regression: deploys failed at an old head, the next push's diff selected
    // no apps (envs.ts-only fix), and the recorded deploy-failed state was
    // never retried — deploy skipped, tests skipped, check green, slot broken.
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
          notice: null,
        },
        pullRequestHeadSha: "current-head",
      }).map((app) => app.slug),
    ).toEqual(["os", "auth"]);
  });

  it("does not re-run awaiting-tests apps from older commits", () => {
    expect(
      selectPreviewAppsNeedingRetry({
        previousState: {
          apps: {
            os: {
              appDisplayName: "OS",
              appSlug: "os",
              headSha: "old-head",
              status: "awaiting-tests",
              updatedAt: "2026-05-01T00:00:00.000Z",
            },
          },
          environmentConfigLease: null,
          notice: null,
        },
        pullRequestHeadSha: "current-head",
      }),
    ).toEqual([]);
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

  it("selects nothing when the head is unchanged, every app is green, and every app is serving", async () => {
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

  it("self-heals an erased slot: a parked recorded-green app is redeployed with its dependencies", async () => {
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
            status: "tests-failed",
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

    expect(apps.map((app) => app.slug)).toEqual(["os", "auth", "streams-example-app"]);
    // Only the green claims get probed — the failed app is already selected
    // for retry — and each app is probed on its own readiness path.
    expect(probedUrls).toEqual([
      "https://os.iterate-preview-7.com/api/health",
      "https://auth.iterate-preview-7.com/api/auth/ok",
    ]);
  });

  it("retries failed apps even when the push's diff does not touch them", async () => {
    // A slot whose deploy failed at an old head must not stay wedged just
    // because the next push's diff selects other apps.
    const apps = await selectPreviewAppsForPullRequest({
      ...selectionInput,
      previousState: {
        apps: {
          os: recordedApp("os", "OS", {
            headSha: "old-head",
            shortSha: "oldhead",
            status: "deploy-failed",
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

    expect(apps.map((app) => app.slug)).toEqual(["os", "semaphore", "auth"]);
  });

  it("deploys the full fleet when the compare 404s because a force-push rewrote the deployed head away", async () => {
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

    expect(apps.map((app) => app.slug)).toEqual(["os", "semaphore", "auth", "streams-example-app"]);
  });

  it("deploys the full fleet when the deployed head is no longer an ancestor of the current head", async () => {
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

    expect(apps.map((app) => app.slug)).toEqual(["os", "semaphore", "auth", "streams-example-app"]);
  });

  it("propagates non-404 compare failures instead of guessing a selection", async () => {
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
  it("trusts the normal push shapes", () => {
    expect(describeForcePushCompareHazard("ahead")).toBeNull();
    expect(describeForcePushCompareHazard("identical")).toBeNull();
  });

  it("flags rewritten history as untrustworthy for diffing", () => {
    expect(describeForcePushCompareHazard("diverged")).toContain("not an ancestor");
    expect(describeForcePushCompareHazard("behind")).toContain("not an ancestor");
  });
});

describe("preview test skip verdicts", () => {
  const recordedApps = {
    os: CloudflarePreviewAppEntry.parse({
      appDisplayName: "OS",
      appSlug: "os",
      headSha: "old-head",
      shortSha: "oldhead",
      status: "deployed",
      updatedAt: "2026-07-09T00:00:00.000Z",
    }),
  };

  it("skips green when deploy would select nothing for this head", () => {
    const skip = explainPreviewTestSkip({
      appsDeployWouldSelect: [],
      pullRequestHeadSha: "current-head",
      recordedApps,
    });

    expect(skip.verdict).toBe("nothing-changed");
    expect(skip.notice).toContain("nothing app-affecting changed");
    expect(skip.notice).toContain("still stand");
  });

  it("fails loudly when apps are recorded at a stale head", () => {
    // A push that races between the deploy and test steps (or a deploy that
    // died before recording) leaves the recorded apps at an old head; a green
    // "deploy + e2e" would then describe a commit that never ran.
    const skip = explainPreviewTestSkip({
      appsDeployWouldSelect: ["os", "auth"],
      pullRequestHeadSha: "current-head",
      recordedApps,
    });

    expect(skip.verdict).toBe("stale-head");
    expect(skip.notice).toContain("refused to skip");
    expect(skip.notice).toContain("os, auth");
    expect(skip.notice).toContain("E2e was NOT run");
    expect(skip.notice).toContain(
      "os: deployed, head oldhead (stale — deploy has not run for the current head)",
    );
  });

  it("fails loudly when nothing is recorded at all but deploy would select apps", () => {
    const skip = explainPreviewTestSkip({
      appsDeployWouldSelect: ["os"],
      pullRequestHeadSha: "current-head",
      recordedApps: {},
    });

    expect(skip.verdict).toBe("stale-head");
    expect(skip.notice).toContain("No apps are recorded at all");
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
      "<summary>Lease: preview-2 | Doppler config: preview_2 | Type: environment-config-lease | Leased until: 2023-11-14T22:13:20.000Z</summary>\n\n| app | status | commit | preview | size (gzip) | deploy duration | test duration | retries | cleanup duration | workflow run | updated | summary |",
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
      notice: null,
    });

    expect(body).toContain("# User content");
    expect(body).toContain("Footer");
    expect(body).toContain("<summary>No active environment config lease.</summary>");
    expect(body).toContain(
      "| OS | tests failed | `1234567` |  |  |  |  |  |  | [Workflow run](https://github.com/iterate/iterate/actions/runs/456) | 2026-04-02T10:00:00.000Z | AssertionError: expected 2 to be +0 |",
    );
    expect(body).toContain("<details>");
    expect(body).toContain("<summary>OS failure details</summary>");
  });

  it("returns empty state when the managed block is deleted", () => {
    expect(parseCloudflarePreviewState("## Summary\n\nNo preview block here.")).toEqual({
      apps: {},
      environmentConfigLease: null,
      notice: null,
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
      notice: null,
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

  it("rejects PR-body lease metadata that repoints a slot", () => {
    expect(() =>
      EnvironmentConfigLease.parse({
        dopplerConfig: "preview_3",
        leasedUntil: 1_800_000_000_000,
        leaseId: "0197a5b3-a705-7380-8958-6a0dbead16b7",
        slug: "preview-2",
        type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
      }),
    ).toThrow("must use canonical Doppler config preview_2");
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
  it("requires the canonical Doppler config for the slot", () => {
    expect(parseEnvironmentConfigLeaseData("preview-2", { dopplerConfig: " preview_2 " })).toEqual({
      dopplerConfig: "preview_2",
    });
    expect(() => parseEnvironmentConfigLeaseData("preview-2", {})).toThrow(
      "Environment config lease data must include dopplerConfig.",
    );
    expect(() =>
      parseEnvironmentConfigLeaseData("preview-2", { dopplerConfig: "preview_3" }),
    ).toThrow("must use canonical Doppler config preview_2");
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

  it("reports a repointed resource without accessing the supplied environment", async () => {
    const checkDopplerConfig = vi.fn(async () => ({ ok: true as const }));
    const readCloudflareCredentials = vi.fn(async ({ project }: { project: string }) => ({
      ok: true as const,
      project,
      accountId: "cf-account",
      apiToken: "redacted",
    }));

    const result = await reconcileEnvironmentConfigLeaseResources({
      client: {
        list: async () => [
          {
            slug: "preview-2",
            data: { dopplerConfig: "preview_3" },
            leaseState: "available",
            leasedUntil: null,
          },
        ],
      },
      checkDopplerConfig,
      readCloudflareCredentials,
      checkCloudflareZone: async () => ({ ok: true }),
      commandEnvironment: {},
      repositoryRoot: "/repo",
      semaphoreBaseUrl: "https://semaphore.iterate.com",
    });

    expect(result.ok).toBe(false);
    expect(result.resources[0]?.issues).toEqual([
      expect.objectContaining({
        check: "resource-data",
        message: expect.stringContaining("canonical Doppler config preview_2"),
      }),
    ]);
    expect(checkDopplerConfig).not.toHaveBeenCalled();
    expect(readCloudflareCredentials).not.toHaveBeenCalled();
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

describe("preview section notice banner", () => {
  it("renders the notice as a GitHub caution alert above the lease details", () => {
    const body = renderCloudflarePreviewPullRequestBody("", {
      apps: {},
      environmentConfigLease: null,
      notice: "All preview slots are leased.\n  preview-1  leased by pr-1601",
    });
    expect(body).toContain("> [!CAUTION]");
    expect(body).toContain("> All preview slots are leased.");
    expect(body).toContain("> " + "  preview-1  leased by pr-1601");
  });

  it("renders no alert when there is no notice", () => {
    const body = renderCloudflarePreviewPullRequestBody("", {
      apps: {},
      environmentConfigLease: null,
      notice: null,
    });
    expect(body).not.toContain("[!CAUTION]");
  });
});

describe("lease holder helpers", () => {
  it("derives a PR url from pr-N holders", () => {
    expect(holderPullRequestUrl("pr-1592")).toBe("https://github.com/iterate/iterate/pull/1592");
    expect(holderPullRequestUrl("manual-jonas")).toBeNull();
    expect(holderPullRequestUrl(null)).toBeNull();
  });

  it("parses PREVIEW_SLOT_WAIT_MS overrides", () => {
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
  phase: "preparing" | "ready";
  slug: string;
  type: string;
};

function fakeLease(overrides: Partial<FakeLease> = {}): FakeLease {
  return {
    data: { dopplerConfig: "preview_2" },
    expiresAt: Date.now() + 60_000,
    holder: "pr-1600",
    leaseId: "9d975621-72c8-459d-936d-e9b4335e0f5d",
    phase: "preparing",
    slug: "preview-2",
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
    ...overrides,
  };
}

type FakeResource = {
  data: Record<string, unknown>;
  holder: string | null;
  lastAcquiredAt: number | null;
  lastReleasedAt: number | null;
  leaseState: "available" | "leased";
  leasedUntil: number | null;
  slug: string;
};

function fakeResource(overrides: Partial<FakeResource> = {}): FakeResource {
  return {
    data: { dopplerConfig: "preview_2" },
    holder: "pr-1600",
    lastAcquiredAt: null,
    lastReleasedAt: null,
    leaseState: "leased",
    leasedUntil: Date.now() + 60_000,
    slug: "preview-2",
    ...overrides,
  };
}

function fakeSemaphore(overrides: Record<string, unknown> = {}) {
  return {
    add: vi.fn(async () => ({ created: true })),
    acquireExclusive: vi.fn(async () => fakeLease()),
    acquireSpecific: vi.fn(async () => null),
    delete: vi.fn(async () => ({ deleted: true })),
    markReady: vi.fn(async () => fakeLease({ phase: "ready" })),
    renew: vi.fn(async () => null),
    release: vi.fn(async () => ({ released: true })),
    list: vi.fn(async () => []),
    ...overrides,
  };
}

const previousLease = EnvironmentConfigLease.parse({
  dopplerConfig: "preview_2",
  leasedUntil: 1_700_000_000_000,
  leaseId: "9d975621-72c8-459d-936d-e9b4335e0f5d",
  slug: "preview-2",
  type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
});

describe("environment preparation transition", () => {
  function completeFleet(headSha = "current-head") {
    return Object.fromEntries(
      Object.values(cloudflarePreviewApps).map((app) => [
        app.slug,
        CloudflarePreviewAppEntry.parse({
          appDisplayName: app.displayName,
          appSlug: app.slug,
          headSha,
          status: "awaiting-tests",
          updatedAt: "2026-07-13T00:00:00.000Z",
        }),
      ]),
    );
  }

  it("marks only the exact lease ready after the complete fleet is deployed", async () => {
    const markReady = vi.fn(async () =>
      fakeLease({
        leaseId: previousLease.leaseId,
        phase: "ready",
      }),
    );
    const semaphore = fakeSemaphore({ markReady });

    await expect(
      completeEnvironmentPreparation({
        apps: completeFleet(),
        lease: previousLease,
        pullRequestHeadSha: "current-head",
        semaphore,
      }),
    ).resolves.toBe(true);
    expect(markReady).toHaveBeenCalledExactlyOnceWith({
      type: previousLease.type,
      slug: previousLease.slug,
      leaseId: previousLease.leaseId,
    });
  });

  it("leaves the lease preparing when any app is incomplete", async () => {
    const markReady = vi.fn(async () => fakeLease({ phase: "ready" }));
    const apps = completeFleet();
    apps.auth = { ...apps.auth, status: "deploy-failed" };

    await expect(
      completeEnvironmentPreparation({
        apps,
        lease: previousLease,
        pullRequestHeadSha: "current-head",
        semaphore: fakeSemaphore({ markReady }),
      }),
    ).resolves.toBe(false);
    expect(markReady).not.toHaveBeenCalled();
  });

  it("rejects a stale mark-ready response", async () => {
    await expect(
      completeEnvironmentPreparation({
        apps: completeFleet(),
        lease: previousLease,
        pullRequestHeadSha: "current-head",
        semaphore: fakeSemaphore({ markReady: vi.fn(async () => null) }),
      }),
    ).rejects.toThrow(`did not mark exact lease ${previousLease.leaseId} ready`);
  });
});

describe("claimEnvironmentConfigLease", () => {
  it("renews the recorded lease when this PR still holds it", async () => {
    const semaphore = fakeSemaphore({
      list: vi.fn(async () => [fakeResource()]),
      renew: vi.fn(async () => fakeLease({ expiresAt: 1_800_000_000_000, phase: "ready" })),
    });

    const { preparationRequired, lease } = await claimEnvironmentConfigLease({
      createPreviewSemaphoreResourceClient: () => semaphore,
      holder: "pr-1600",
      leaseMs: 1000,
      previousEnvironmentConfigLease: previousLease,
      waitTotalMs: 0,
    });

    expect(lease.slug).toBe("preview-2");
    expect(lease.leasedUntil).toBe(1_800_000_000_000);
    expect(preparationRequired).toBe(false);
    expect(semaphore.acquireExclusive).not.toHaveBeenCalled();
    expect(semaphore.acquireSpecific).not.toHaveBeenCalled();
  });

  it("re-takes the recorded slot when the lease expired but the slot is free", async () => {
    const semaphore = fakeSemaphore({
      acquireSpecific: vi.fn(async () =>
        fakeLease({ leaseId: "1197a5b3-a705-4380-9958-6a0dbead16b7" }),
      ),
    });

    const { preparationRequired, lease } = await claimEnvironmentConfigLease({
      createPreviewSemaphoreResourceClient: () => semaphore,
      holder: "pr-1600",
      leaseMs: 1000,
      previousEnvironmentConfigLease: previousLease,
      waitTotalMs: 0,
    });

    expect(lease.slug).toBe("preview-2");
    expect(lease.leaseId).toBe("1197a5b3-a705-4380-9958-6a0dbead16b7");
    expect(preparationRequired).toBe(true);
    expect(semaphore.acquireSpecific).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "preview-2", holder: "pr-1600" }),
    );
    expect(semaphore.acquireSpecific).toHaveBeenCalledWith(
      expect.not.objectContaining({ force: true }),
    );
    expect(semaphore.acquireExclusive).not.toHaveBeenCalled();
  });

  it("moves to a fresh slot when someone else now holds the recorded one", async () => {
    const semaphore = fakeSemaphore({
      acquireExclusive: vi.fn(async () =>
        fakeLease({ slug: "preview-5", data: { dopplerConfig: "preview_5" } }),
      ),
      list: vi.fn(async () => [
        {
          data: { dopplerConfig: "preview_2" },
          holder: "pr-1601",
          lastAcquiredAt: null,
          lastReleasedAt: null,
          leaseState: "leased" as const,
          leasedUntil: Date.now() + 60_000,
          slug: "preview-2",
        },
      ]),
    });

    const { preparationRequired, lease } = await claimEnvironmentConfigLease({
      createPreviewSemaphoreResourceClient: () => semaphore,
      holder: "pr-1600",
      leaseMs: 1000,
      previousEnvironmentConfigLease: previousLease,
      waitTotalMs: 0,
    });

    expect(lease.slug).toBe("preview-5");
    expect(lease.dopplerConfig).toBe("preview_5");
    expect(preparationRequired).toBe(true);
    expect(semaphore.acquireExclusive).toHaveBeenCalledWith(
      expect.objectContaining({ holder: "pr-1600" }),
    );
  });

  it("acquires a fresh preparing lease without doing destructive work before persistence", async () => {
    const semaphore = fakeSemaphore({
      acquireExclusive: vi.fn(async () =>
        fakeLease({
          data: { dopplerConfig: "preview_3" },
          slug: "preview-3",
        }),
      ),
    });

    await expect(
      claimEnvironmentConfigLease({
        createPreviewSemaphoreResourceClient: () => semaphore,
        holder: "pr-1600",
        leaseMs: 1000,
        previousEnvironmentConfigLease: null,
        waitTotalMs: 0,
      }),
    ).resolves.toMatchObject({
      preparationRequired: true,
      lease: { slug: "preview-3" },
    });

    expect(semaphore.acquireSpecific).not.toHaveBeenCalled();
    expect(semaphore.acquireExclusive).toHaveBeenCalledOnce();
  });

  it("refuses stale same-holder state without attempting a replacement", async () => {
    const semaphore = fakeSemaphore({
      renew: vi.fn(async () => null),
      list: vi.fn(async () => [fakeResource()]),
    });

    await expect(
      claimEnvironmentConfigLease({
        createPreviewSemaphoreResourceClient: () => semaphore,
        holder: "pr-1600",
        leaseMs: 1000,
        previousEnvironmentConfigLease: previousLease,
        waitTotalMs: 0,
      }),
    ).rejects.toThrow(/recorded lease ID is stale/);

    expect(semaphore.acquireSpecific).not.toHaveBeenCalled();
    expect(semaphore.acquireExclusive).not.toHaveBeenCalled();
  });

  it("propagates unexpected semaphore errors instead of silently switching slots", async () => {
    const semaphore = fakeSemaphore({
      list: vi.fn(async () => [fakeResource()]),
      renew: vi.fn(async () => {
        throw new Error("semaphore is down");
      }),
    });

    await expect(
      claimEnvironmentConfigLease({
        createPreviewSemaphoreResourceClient: () => semaphore,
        holder: "pr-1600",
        leaseMs: 1000,
        previousEnvironmentConfigLease: previousLease,
        waitTotalMs: 0,
      }),
    ).rejects.toThrow("semaphore is down");
    expect(semaphore.acquireExclusive).not.toHaveBeenCalled();
  });
});

describe("acquireAnyEnvironmentConfigLease", () => {
  function conflictError() {
    const error = new Error("No resource is currently available for this type.");
    (error as Error & { code: string }).code = "CONFLICT";
    return error;
  }

  it("queues while all slots are leased and takes the first free one", async () => {
    const acquireExclusive = vi
      .fn()
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValueOnce(
        fakeLease({ slug: "preview-7", data: { dopplerConfig: "preview_7" } }),
      );
    const semaphore = fakeSemaphore({ acquireExclusive });

    const lease = await acquireAnyEnvironmentConfigLease({
      semaphore,
      holder: "pr-1600",
      leaseMs: 1000,
      waitTotalMs: 60_000,
    });

    expect(lease.slug).toBe("preview-7");
    expect(acquireExclusive).toHaveBeenCalledTimes(2);
  });

  it("fails with the holder table and remediation once the wait budget is spent", async () => {
    const semaphore = fakeSemaphore({
      acquireExclusive: vi.fn(async () => {
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
        semaphore,
        holder: "pr-1600",
        leaseMs: 1000,
        waitTotalMs: 0,
      }),
    ).rejects.toThrow(/pr-1601[\s\S]*preview reclaim --slot N/);
  });

  it("propagates non-contention errors immediately", async () => {
    const semaphore = fakeSemaphore({
      acquireExclusive: vi.fn(async () => {
        throw new Error("UNAUTHORIZED");
      }),
    });

    await expect(
      acquireAnyEnvironmentConfigLease({
        semaphore,
        holder: "pr-1600",
        leaseMs: 1000,
        waitTotalMs: 60_000,
      }),
    ).rejects.toThrow("UNAUTHORIZED");
  });
});

describe("reassertEnvironmentConfigLease", () => {
  it("confirms a still-held lease by renewing it", async () => {
    const semaphore = fakeSemaphore({
      list: vi.fn(async () => [fakeResource()]),
      renew: vi.fn(async () => fakeLease()),
    });

    const result = await reassertEnvironmentConfigLease({
      holder: "pr-1600",
      lease: previousLease,
      leaseMs: 1000,
      semaphore,
    });

    expect(result.ok).toBe(true);
  });

  it("reports an interrupted exact generation as preparing", async () => {
    const semaphore = fakeSemaphore({
      list: vi.fn(async () => [fakeResource()]),
      renew: vi.fn(async () => fakeLease({ phase: "preparing" })),
    });

    const result = await reassertEnvironmentConfigLease({
      holder: "pr-1600",
      lease: previousLease,
      leaseMs: 1000,
      semaphore,
    });

    expect(result).toMatchObject({ ok: true, preparationRequired: true });
  });

  it("refuses to repair its own lease when the recorded leaseId is stale", async () => {
    const acquireSpecific = vi.fn(async () => null);
    const semaphore = fakeSemaphore({
      acquireSpecific,
      list: vi.fn(async () => [fakeResource()]),
    });

    const result = await reassertEnvironmentConfigLease({
      holder: "pr-1600",
      lease: previousLease,
      leaseMs: 1000,
      semaphore,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("recorded lease ID is stale");
    expect(acquireSpecific).not.toHaveBeenCalled();
  });

  it("refuses a renewal response attributed to a different holder", async () => {
    const semaphore = fakeSemaphore({
      list: vi.fn(async () => [fakeResource()]),
      renew: vi.fn(async () => fakeLease({ holder: "pr-1601" })),
    });

    const result = await reassertEnvironmentConfigLease({
      holder: "pr-1600",
      lease: previousLease,
      leaseMs: 1000,
      semaphore,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.currentHolder).toBe("pr-1601");
  });

  it("does not re-acquire an expired capability", async () => {
    const acquireSpecific = vi.fn(async () =>
      fakeLease({ leaseId: "1197a5b3-a705-4380-9958-6a0dbead16b7" }),
    );
    const semaphore = fakeSemaphore({
      renew: vi.fn(async () => null),
      acquireSpecific,
    });

    const result = await reassertEnvironmentConfigLease({
      holder: "pr-1600",
      lease: previousLease,
      leaseMs: 1000,
      semaphore,
    });

    expect(result.ok).toBe(false);
    expect(acquireSpecific).not.toHaveBeenCalled();
  });

  it("refuses when the slot now belongs to another PR", async () => {
    const renew = vi.fn(async () => null);
    const semaphore = fakeSemaphore({
      renew,
      list: vi.fn(async () => [
        fakeResource({
          holder: "pr-1601",
        }),
      ]),
    });

    const result = await reassertEnvironmentConfigLease({
      holder: "pr-1600",
      lease: previousLease,
      leaseMs: 1000,
      semaphore,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.currentHolder).toBe("pr-1601");
      expect(result.message).toContain("preview-2");
      expect(result.message).toContain("pr-1601");
      expect(result.message).toContain("https://github.com/iterate/iterate/pull/1601");
    }
    expect(renew).toHaveBeenCalledOnce();
  });
});

describe("lease reclaim verdicts", () => {
  const { classifyLeaseForReclaim } = previewInternals;
  const hourMs = 3_600_000;
  const now = 1_700_000_000_000;

  it("classifies unleased slots as available", () => {
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

  it("reports closed-PR holders as orphan candidates regardless of recency", () => {
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

  it("treats failed PR-state checks as active regardless of idleness", () => {
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

  it("classifies stale open holds as idle and fresh ones as active", () => {
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

describe("destructive lease reclaim", () => {
  const orphaned = {
    holder: "pr-1580",
    lastUsedAgo: "1m ago",
    leasedUntil: "2026-07-14T12:00:00.000Z",
    pullRequestUrl: "https://github.com/iterate/iterate/pull/1580",
    slug: "preview-2",
    verdict: "orphaned" as const,
  };

  it("requires explicit force even when the holder PR is closed", () => {
    expect(() => requireExplicitReclaimForce(orphaned, undefined)).toThrow(
      /may race its owner's deploy or close-triggered cleanup/,
    );
  });

  it("allows a verified operator takeover", () => {
    expect(() => requireExplicitReclaimForce(orphaned, true)).not.toThrow();
  });
});

describe("lease ownership during acquire", () => {
  function conflictError() {
    const error = new Error("No resource is currently available for this type.");
    (error as Error & { code: string }).code = "CONFLICT";
    return error;
  }

  it("never force-acquires a held slot while its owner may be cleaning it up", async () => {
    const acquireSpecific = vi.fn();
    const semaphore = fakeSemaphore({
      acquireExclusive: vi.fn(async () => {
        throw conflictError();
      }),
      acquireSpecific,
    });

    await expect(
      acquireAnyEnvironmentConfigLease({
        semaphore,
        holder: "pr-1600",
        leaseMs: 1000,
        waitTotalMs: 0,
      }),
    ).rejects.toThrow(/Automation never force-reclaims a held slot/);

    expect(acquireSpecific).not.toHaveBeenCalled();
  });

  it("returns a fresh capability without performing destructive work", async () => {
    const acquireExclusive = vi.fn(async () =>
      fakeLease({ slug: "preview-7", data: { dopplerConfig: "preview_7" } }),
    );
    const semaphore = fakeSemaphore({ acquireExclusive });

    const lease = await acquireAnyEnvironmentConfigLease({
      semaphore,
      holder: "pr-1600",
      leaseMs: 1000,
      waitTotalMs: 0,
    });

    expect(lease.slug).toBe("preview-7");
  });

  it("requires an exact preparing generation before handover", async () => {
    const { assertExactEnvironmentConfigLease } = previewInternals;
    const semaphore = fakeSemaphore({
      renew: vi.fn(async () => fakeLease({ phase: "ready" })),
    });

    await expect(
      assertExactEnvironmentConfigLease({
        expectedPhase: "preparing",
        lease: previousLease,
        semaphore,
        holder: "pr-1600",
        leaseMs: 1000,
      }),
    ).rejects.toThrow("is no longer authoritative");
  });

  it("accepts the exact ready generation before a continuous deploy", async () => {
    const { assertExactEnvironmentConfigLease } = previewInternals;
    const renew = vi.fn(async () => fakeLease({ phase: "ready" }));

    const lease = await assertExactEnvironmentConfigLease({
      expectedPhase: "ready",
      lease: previousLease,
      semaphore: fakeSemaphore({ renew }),
      holder: "pr-1600",
      leaseMs: 1000,
    });

    expect(lease.phase).toBe("ready");
    expect(renew).toHaveBeenCalledWith({
      type: previousLease.type,
      slug: previousLease.slug,
      leaseId: previousLease.leaseId,
      leaseMs: 1000,
    });
  });

  it("rejects lease metadata that repoints cleanup", async () => {
    const { assertExactEnvironmentConfigLease } = previewInternals;
    const semaphore = fakeSemaphore({
      renew: vi.fn(async () =>
        fakeLease({ slug: "preview-2", data: { dopplerConfig: "preview_8" } }),
      ),
    });

    await expect(
      assertExactEnvironmentConfigLease({
        expectedPhase: "preparing",
        lease: previousLease,
        semaphore,
        holder: "pr-1600",
        leaseMs: 1000,
      }),
    ).rejects.toThrow(/must use canonical Doppler config preview_2/);
  });

  it("quarantines an exact lease when its erase fails", async () => {
    const { eraseAcquiredSlotOrQuarantine } = previewInternals;

    await expect(
      eraseAcquiredSlotOrQuarantine({
        eraseSlotData: async () => {
          throw new Error("erase failed");
        },
        lease: fakeLease(),
      }),
    ).rejects.toThrow(/lease remains held so no replacement can race cleanup/);
  });
});

describe("assignEnvironmentConfigLease", () => {
  const { assignEnvironmentConfigLease } = previewInternals;

  it("keeps and renews the recorded slot when no specific slot is requested", async () => {
    const semaphore = fakeSemaphore({
      list: vi.fn(async () => [fakeResource()]),
      renew: vi.fn(async () => fakeLease({ expiresAt: 1_800_000_000_000, phase: "ready" })),
    });

    const result = await assignEnvironmentConfigLease({
      holder: "pr-1600",
      leaseMs: 1000,
      recordedLease: previousLease,
      semaphore,
      wantedSlug: null,
    });

    expect(result.outcome).toBe("kept");
    expect(result.lease.slug).toBe("preview-2");
    expect(result.changedFromSlug).toBeNull();
    expect(semaphore.acquireExclusive).not.toHaveBeenCalled();
  });

  it("keeps the recorded slot when it is the one requested", async () => {
    const semaphore = fakeSemaphore({
      list: vi.fn(async () => [fakeResource()]),
      renew: vi.fn(async () => fakeLease({ phase: "ready" })),
    });

    const result = await assignEnvironmentConfigLease({
      holder: "pr-1600",
      leaseMs: 1000,
      recordedLease: previousLease,
      semaphore,
      wantedSlug: "preview-2",
    });

    expect(result.outcome).toBe("kept");
    expect(semaphore.acquireSpecific).not.toHaveBeenCalled();
  });

  it("moves to the requested slot and releases the previously held lease", async () => {
    const release = vi.fn(async () => ({ released: true }));
    const acquireSpecific = vi.fn(async () =>
      fakeLease({
        slug: "preview-5",
        data: { dopplerConfig: "preview_5" },
        leaseId: "1197a5b3-a705-4380-9958-6a0dbead16b7",
      }),
    );
    const semaphore = fakeSemaphore({
      list: vi.fn(async () => [fakeResource()]),
      renew: vi.fn(async () => fakeLease()),
      acquireSpecific,
      release,
    });

    const result = await assignEnvironmentConfigLease({
      holder: "pr-1600",
      leaseMs: 1000,
      recordedLease: previousLease,
      semaphore,
      wantedSlug: "preview-5",
    });

    expect(result.outcome).toBe("moved");
    expect(result.lease.slug).toBe("preview-5");
    expect(result.changedFromSlug).toBe("preview-2");
    expect(result.previousLeaseReleased).toBe(true);
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "preview-2", leaseId: previousLease.leaseId }),
    );
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(
      acquireSpecific.mock.invocationCallOrder[0]!,
    );
  });

  it("reports broken ownership when re-acquiring the same slug after losing it", async () => {
    // renew and non-force acquireSpecific fail (someone else held it in the
    // interim); --force re-takes the SAME slug. Outcome must not be "kept".
    const acquireSpecific = vi.fn(async (input: { force?: boolean }) =>
      input.force ? fakeLease({ leaseId: "1197a5b3-a705-4380-9958-6a0dbead16b7" }) : null,
    );
    const semaphore = fakeSemaphore({
      acquireSpecific,
      list: vi.fn(async () => [
        {
          data: { dopplerConfig: "preview_2" },
          holder: "pr-1601",
          lastAcquiredAt: null,
          lastReleasedAt: null,
          leaseState: "leased" as const,
          leasedUntil: Date.now() + 60_000,
          slug: "preview-2",
        },
      ]),
    });

    const result = await assignEnvironmentConfigLease({
      force: true,
      holder: "pr-1600",
      leaseMs: 1000,
      recordedLease: previousLease,
      semaphore,
      wantedSlug: "preview-2",
    });

    expect(result.outcome).toBe("assigned");
    expect(result.lease.slug).toBe("preview-2");
    expect(result.changedFromSlug).toBeNull();
  });

  it("explains who holds a requested slot instead of taking it without --force", async () => {
    const semaphore = fakeSemaphore({
      list: vi.fn(async () => [
        {
          data: { dopplerConfig: "preview_5" },
          holder: "pr-1601",
          lastAcquiredAt: null,
          lastReleasedAt: null,
          leaseState: "leased" as const,
          leasedUntil: Date.now() + 60_000,
          slug: "preview-5",
        },
      ]),
    });

    await expect(
      assignEnvironmentConfigLease({
        holder: "pr-1600",
        leaseMs: 1000,
        recordedLease: null,
        semaphore,
        wantedSlug: "preview-5",
      }),
    ).rejects.toThrow(/pr-1601[\s\S]*--force/);
  });

  it("passes force through to evict the current holder", async () => {
    const acquireSpecific = vi.fn(async () =>
      fakeLease({ slug: "preview-5", data: { dopplerConfig: "preview_5" } }),
    );
    const semaphore = fakeSemaphore({ acquireSpecific });

    const result = await assignEnvironmentConfigLease({
      force: true,
      holder: "pr-1600",
      leaseMs: 1000,
      recordedLease: null,
      semaphore,
      wantedSlug: "preview-5",
    });

    expect(result.outcome).toBe("assigned");
    expect(acquireSpecific).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
  });

  it("returns a preparing handover for the caller to persist before erasing", async () => {
    const semaphore = fakeSemaphore({
      acquireSpecific: vi.fn(async () =>
        fakeLease({ slug: "preview-5", data: { dopplerConfig: "preview_5" } }),
      ),
    });

    const result = await assignEnvironmentConfigLease({
      force: true,
      holder: "pr-1600",
      leaseMs: 1000,
      recordedLease: null,
      semaphore,
      wantedSlug: "preview-5",
    });

    expect(result.lease.slug).toBe("preview-5");
    expect(result.preparationRequired).toBe(true);
  });

  it("does not acquire a second slot when releasing the old exact lease fails", async () => {
    const acquireSpecific = vi.fn(async () =>
      fakeLease({ slug: "preview-5", data: { dopplerConfig: "preview_5" } }),
    );
    const semaphore = fakeSemaphore({
      acquireSpecific,
      renew: vi.fn(async () => fakeLease({ phase: "ready" })),
      release: vi.fn(async () => ({ released: false })),
    });

    await expect(
      assignEnvironmentConfigLease({
        holder: "pr-1600",
        leaseMs: 1000,
        recordedLease: previousLease,
        semaphore,
        wantedSlug: "preview-5",
      }),
    ).rejects.toThrow(/refusing to acquire a second slot/);
    expect(acquireSpecific).not.toHaveBeenCalled();
  });
});
