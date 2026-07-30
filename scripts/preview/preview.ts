import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as dns } from "node:dns";
import { mkdir, readFile, rm } from "node:fs/promises";
import { userInfo } from "node:os";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, resolve } from "node:path";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { createSemaphoreClient } from "../../apps/semaphore/src/contract.ts";
import {
  authEnvs,
  docsEnvs,
  dummyPetshopEnvs,
  envs,
  claimablePreviewEnvironmentSlotNumbers,
  previewEnvironmentSlotNumbers,
  semaphoreEnvs,
  streamsExampleEnvs,
} from "../../envs.ts";
import {
  destroyEnvironment as destroyManagedEnvironment,
  environmentStage,
  readEnvironmentState,
} from "../../apps/env-manager/scripts/client.ts";
import type { EnvironmentState } from "../../apps/env-manager/src/state.ts";
import { createSemaphoreTokenProvider } from "../auth/semaphore-token.ts";
import { markdownAnnotator } from "../../packages/shared/src/dev/markdown-annotator.ts";
import { stripAnsi } from "../../packages/shared/src/dev/strip-ansi.ts";
import { runCommand } from "../../packages/shared/src/node/run-command.ts";
import {
  TestTelemetryArtifact,
  type TestTelemetryArtifactSource,
} from "../../packages/shared/src/test-support/ci-telemetry.ts";
import { fetchCloudflareWith429Retry } from "../lib/cloudflare-429-retry.ts";
import {
  compactRetryFailure,
  OS_ONBOARDING_SMOKE_TIMEOUT_SECS,
  OS_PREVIEW_LANE_TIMEOUT_SECS,
  OS_TUI_LANE_TIMEOUT_SECS,
} from "../../packages/shared/src/test-support/e2e-policy/index.ts";
import {
  E2E_CLOUDFLARE_WORKERS_VERSION_OVERRIDES_ENV,
  renderCloudflareWorkerVersionOverrides,
} from "../../packages/shared/src/test-support/cloudflare-worker-version-overrides.ts";
import { PREVIEW_APP_ROLLOUT_READY_AT_MS_ENV } from "../../packages/shared/src/test-support/preview-rollout-gate.ts";
import {
  parseWorkerSizeFromDeployOutput,
  parseWorkerSizeStatusDescription,
  renderWorkerSizeCell,
  workerSizeStatusContext,
  type WorkerSizeInfo,
} from "./worker-size.ts";
import { PreviewE2eTelemetryArtifact } from "./e2e-telemetry.ts";

// Flake-hunt notes for the preview e2e lane live in
// docs/preview-e2e-flake-hunt.md.
type PullRequestCommandOptions = {
  /** GitHub token. Defaults to GITHUB_TOKEN. */
  githubToken?: string;
  /** Pull request number. Defaults to GITHUB_PR_NUMBER. */
  pullRequestNumber?: number;
};

/** Label a draft PR can wear to get previews despite the draft policy below. */
const previewOptInLabel = "preview";

const draftPreviewNotice = [
  "This PR is a draft, so it doesn't claim a preview slot.",
  `To get previews: add the \`${previewOptInLabel}\` label, mark the PR ready for review, or dispatch the Cloudflare Previews workflow for a one-off run.`,
].join(" ");

// Cloudflare documents that a Worker/DO code update is globally eventually
// consistent after the new edge Worker version is serving. A newly addressed
// Durable Object can therefore still be assigned the prior code for seconds
// to minutes, and an in-flight RPC is reset when that assignment changes.
// Keep live e2e work that creates or calls Durable Objects behind a bounded
// deployment-age gate. Apps still start concurrently; long suites can overlap
// independent setup with this clock while short DO suites wait at their own
// boundary, so the gate does not serialize the fleet.
const previewMinimumDeploymentAgeMs = 90_000;
const previewRolloutRemainingSecondsEnvironment = "PREVIEW_APP_ROLLOUT_REMAINING_SECONDS";

/**
 * Draft PRs don't hold preview slots unless they ask: there are only nine
 * slots and drafts are the default for agent-opened PRs, so a busy night of
 * drafts was exhausting the fleet before any human asked for a preview.
 * "Asking" = the `preview` label, marking ready for review, or an explicit
 * `--allow-draft` run (the workflow_dispatch path). A draft that still holds
 * a slot per the semaphore (it was ready once, or opted out again) gives it
 * back.
 */
function decideDraftPreviewPolicy(input: {
  allowDraft: boolean;
  holdsSlot: boolean;
  isDraft: boolean;
  labels: string[];
}): "deploy" | "skip" | "teardown" {
  if (!input.isDraft || input.allowDraft || input.labels.includes(previewOptInLabel)) {
    return "deploy";
  }

  return input.holdsSlot ? "teardown" : "skip";
}

type DeployCommandOptions = PullRequestCommandOptions & {
  /**
   * Deploy every preview app regardless of the diff. Diff selection only
   * redeploys apps affected since their LAST DEPLOYED head. A caller that
   * needs a fresh deployment of the whole fleet — the flake-hunt marathon
   * preflight — uses this explicitly instead of relying on the commit
   * happening to touch a fleet-shared path.
   */
  allApps?: boolean;
  /**
   * Deploy even when the PR is a draft without the `preview` label. Draft
   * PRs otherwise skip previews (or give their slot back); an explicit
   * invocation — workflow_dispatch, the flake-hunt marathon, a human at a
   * terminal — is an ask, so those callers pass this.
   */
  allowDraft?: boolean;
};

/** One PR context + runtime shared by every phase of a preview command. */
async function resolvePreviewCommandSetup(options: PullRequestCommandOptions) {
  const runtime = createPreviewRuntime();
  const context = await resolvePullRequestPreviewContext({
    commandEnvironment: runtime.commandEnvironment,
    githubToken: resolveGithubToken(options, runtime.commandEnvironment),
    pullRequestNumber: resolvePullRequestNumber(options, runtime.commandEnvironment),
  });
  return { context, runtime };
}

/**
 * Deploy affected preview apps for a pull request without running preview e2e.
 */
export async function deploy(options: DeployCommandOptions = {}) {
  const { context, runtime } = await resolvePreviewCommandSetup(options);
  return await withPreviewE2eTelemetry(context, runtime, "deploy", (telemetry) =>
    measurePreviewDeployRun(telemetry, () =>
      deployPreviewApps({ context, options, runtime, telemetry }),
    ),
  );
}

/**
 * Run preview e2e against deployed apps recorded in the managed PR preview section.
 */
export async function test(options: PullRequestCommandOptions = {}) {
  const { context, runtime } = await resolvePreviewCommandSetup(options);
  return await withPreviewE2eTelemetry(context, runtime, "test", (telemetry) =>
    testPreviewApps({ context, runtime, telemetry }),
  );
}

type TestTargetOptions = PullRequestCommandOptions & {
  /** Test runner to invoke against the deployed OS preview. */
  runner: PreviewTestTargetRunner;
  /** Test file path, relative to the repository root for Playwright or apps/os for Vitest. */
  target: string;
  /** Optional test-name pattern passed to the selected runner. */
  grep?: string;
  /** Number of independent sequential invocations against the same deployment. Defaults to 1. */
  repeat?: number;
};

/**
 * Run one OS Vitest file or Playwright spec against an already-deployed PR
 * preview. This renews the existing lease but never deploys, destroys, or
 * marks the app's full preview suite green.
 */
export async function testTarget(options: TestTargetOptions) {
  const selection = z
    .object({
      grep: z.string().trim().min(1).optional(),
      repeat: z.number().int().min(1).max(100).default(1),
      runner: z.enum(["vitest", "playwright"]),
      target: z.string().trim().min(1),
    })
    .parse(options);
  const { context, runtime } = await resolvePreviewCommandSetup(options);
  const recorded = (await readCloudflarePreviewState(context)).state;
  const holder = pullRequestHolder(context.pullRequestNumber);
  const semaphore = runtime.createPreviewSemaphoreResourceClient();
  const displaySlot = recorded.environmentConfigLease;
  const environmentConfigLease = await renewRecordedEnvironmentConfigLease({
    holder,
    leaseMs: defaultPreviewLeaseMs,
    recordedLease: displaySlot,
    semaphore,
  });
  if (!environmentConfigLease) {
    throw new Error(
      `Cannot run a targeted preview test: PR #${context.pullRequestNumber} does not hold its recorded preview slot. Run preview deploy first.`,
    );
  }

  const app = cloudflarePreviewApps.os;
  const entry = recorded.apps.os;
  if (!canRunPreviewTests(entry) || entry?.headSha !== context.pullRequestHeadSha) {
    throw new Error(
      `Cannot run a targeted preview test: OS is not recorded as deployed at head ${context.pullRequestHeadSha.slice(0, 7)}. Run preview deploy first.`,
    );
  }
  const baseUrlEnvironment = resolvePreviewTestBaseUrlEnvironment({
    app,
    apps: recorded.apps,
    requiredDeploymentHeadSha: context.pullRequestHeadSha,
  });
  // Match the full preview lane: RPC-only dependencies such as auth need an
  // exact version pin even though they do not contribute a public base URL.
  const versionedAppSlugs = expandPreviewDependencies([app.slug]);
  const workerVersionOverrides = resolvePreviewTestWorkerVersionOverrides({
    apps: recorded.apps,
    appSlugs: versionedAppSlugs,
    dopplerConfig: environmentConfigLease.dopplerConfig,
    requiredDeploymentHeadSha: context.pullRequestHeadSha,
  });
  const plan = resolvePreviewTestTargetPlan({
    ...selection,
    repositoryRoot: runtime.repositoryRoot,
  });
  const telemetryIdentityEnvironment = resolvePreviewTestTelemetryEnvironment({
    app: app.slug,
    context,
    previewSlot: environmentConfigLease.slug,
  });
  await Promise.all(
    [plan.telemetryFile, ...plan.runnerResultFiles].map((file) =>
      mkdir(dirname(file), { recursive: true }),
    ),
  );

  let passed = 0;
  let retries = 0;
  const failures: string[] = [];
  for (let iteration = 1; iteration <= selection.repeat; iteration += 1) {
    await Promise.all(
      [plan.telemetryFile, ...plan.runnerResultFiles].map((file) => rm(file, { force: true })),
    );
    logPreview(
      `target test ${iteration}/${selection.repeat}: ${selection.runner} ${selection.target}${selection.grep ? ` matching ${JSON.stringify(selection.grep)}` : ""} against ${entry.publicUrl}`,
    );
    const result = await runCommand({
      args: [
        "run",
        "--project",
        app.dopplerProject,
        "--config",
        environmentConfigLease.dopplerConfig,
        "--",
        "env",
        "CI=true",
        `${E2E_CLOUDFLARE_WORKERS_VERSION_OVERRIDES_ENV}=${workerVersionOverrides}`,
        ...Object.entries(telemetryIdentityEnvironment).map(([name, value]) => `${name}=${value}`),
        `TEST_TELEMETRY_ARTIFACT_FILE=${plan.telemetryFile}`,
        ...baseUrlEnvironment,
        plan.command,
        ...plan.args,
      ],
      command: "doppler",
      environment: runtime.commandEnvironment,
      signal: runtime.signal,
      workingDirectory: plan.workingDirectory,
    });
    const summary = await readTestTelemetryLane(`targeted ${selection.runner}`, () =>
      readCanonicalTestTelemetry(plan.telemetryFile, `targeted ${selection.runner}`),
    );
    announceRetryTelemetry("os target", summary);
    retries += summary.retried.reduce((total, test) => total + test.retryCount, 0);
    const failure =
      previewTestFailureMessage({ result, retrySummary: summary }) ??
      (summary.collectionErrors.length
        ? `Structured test telemetry was incomplete: ${summary.collectionErrors.join("; ")}`
        : null);
    if (failure) {
      failures.push(`run ${iteration}: ${failure}`);
      console.error(`[preview] target test failed: ${failure}`);
    } else {
      passed += 1;
      console.error(`[preview] target test passed: run ${iteration}/${selection.repeat}`);
    }
  }

  logPreview(
    `target tests finished: ${passed}/${selection.repeat} passed, ${failures.length} failed, ${retries} retries; deployment was reused without deploy or destroy`,
  );
  if (failures.length > 0) {
    throw new Error(
      `${failures.length}/${selection.repeat} targeted preview test runs failed:\n${failures.join("\n")}`,
    );
  }
  return { ok: true as const, passed, repeat: selection.repeat, retries };
}

/**
 * Deploy then test, in one process — the shape CI runs. The two phases share
 * ONE resolved PR context (head sha) and the deploy's final recorded state,
 * so the class of two-step hazards — a push racing into the gap between the
 * deploy and test steps, and the skip machinery needed to explain it — is
 * structurally gone. Deploy records Semaphore's opaque fencing token and test
 * proves uninterrupted ownership by renewing that exact token. A deploy
 * failure throws before any test runs; a draft skip skips both phases.
 */
export async function run(options: DeployCommandOptions = {}) {
  const { context, runtime } = await resolvePreviewCommandSetup(options);
  return await withPreviewE2eTelemetry(context, runtime, "run", async (telemetry) => {
    const deployResult = await measurePreviewDeployRun(telemetry, () =>
      deployPreviewApps({ context, options, runtime, telemetry }),
    );
    if ("skippedReason" in deployResult && deployResult.skippedReason === "draft") {
      return deployResult;
    }

    // A "nothing to deploy" skip still tests. Unchanged apps may reuse their
    // exact recorded Worker versions, but every PR head earns its own e2e
    // result; a previous head's green is never promoted to this check.
    return await testPreviewApps({ context, runtime, state: deployResult.state, telemetry });
  });
}

async function withPreviewE2eTelemetry<T>(
  context: PullRequestPreviewContext,
  runtime: PreviewRuntime,
  operation: "deploy" | "test" | "run",
  execute: (telemetry: PreviewE2eTelemetryArtifact) => Promise<T>,
): Promise<T> {
  const telemetry = new PreviewE2eTelemetryArtifact({
    branch: context.pullRequestHeadRef,
    environment: runtime.commandEnvironment,
    headSha: context.pullRequestHeadSha,
    operation,
    pullRequestNumber: context.pullRequestNumber,
    runUrl: context.workflowRunUrl,
  });
  const startedAt = Date.now();
  let result!: T;
  let operationError: unknown;
  try {
    result = await execute(telemetry);
  } catch (error) {
    operationError = error;
  }
  telemetry.runFinished({
    status: operationError ? "failed" : previewOperationWasSkipped(result) ? "skipped" : "passed",
    durationMs: Date.now() - startedAt,
    ...(operationError ? { error: operationError } : {}),
  });
  let telemetryError: unknown;
  try {
    await telemetry.shutdown();
  } catch (error) {
    telemetryError = error;
  }
  if (operationError && telemetryError) {
    throw new AggregateError(
      [operationError, telemetryError],
      "Preview command and telemetry artifact recording both failed",
    );
  }
  if (operationError) throw operationError;
  if (telemetryError) throw telemetryError;
  return result;
}

async function measurePreviewDeployRun<T>(
  telemetry: PreviewE2eTelemetryArtifact,
  execute: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  telemetry.deployRunStarted();
  try {
    const result = await execute();
    telemetry.deployRunFinished({
      status: previewOperationWasSkipped(result) ? "skipped" : "passed",
      durationMs: Date.now() - startedAt,
      slot: previewResultSlot(result),
    });
    return result;
  } catch (error) {
    telemetry.deployRunFinished({
      status: "failed",
      durationMs: Date.now() - startedAt,
      error,
    });
    throw error;
  }
}

function previewOperationWasSkipped(result: unknown) {
  return (
    typeof result === "object" && result !== null && "skipped" in result && result.skipped === true
  );
}

function previewResultSlot(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null || !("state" in result)) return undefined;
  const state = result.state;
  if (typeof state !== "object" || state === null || !("environmentConfigLease" in state)) {
    return undefined;
  }
  const lease = state.environmentConfigLease;
  return typeof lease === "object" &&
    lease !== null &&
    "slug" in lease &&
    typeof lease.slug === "string"
    ? lease.slug
    : undefined;
}

async function deployPreviewApps({
  context,
  options,
  runtime,
  telemetry,
}: {
  context: PullRequestPreviewContext;
  options: DeployCommandOptions;
  runtime: PreviewRuntime;
  telemetry: PreviewE2eTelemetryArtifact;
}) {
  logPreview(
    `deploy for PR #${context.pullRequestNumber} (head ${context.pullRequestHeadSha.slice(0, 7)}) — holder ${pullRequestHolder(context.pullRequestNumber)}, semaphore ${defaultSemaphoreBaseUrl}`,
  );

  const current = await readCloudflarePreviewState(context);
  logPreview(
    current.state.environmentConfigLease
      ? `PR body references slot ${current.state.environmentConfigLease.slug} (doppler config ${current.state.environmentConfigLease.dopplerConfig}); Semaphore renewal decides ownership`
      : "PR body shows no slot — this PR has not recorded a deploy yet",
  );

  // The semaphore is the single source of lease truth: the draft policy's
  // "does this PR hold a slot?" question goes there, not to the PR body,
  // whose copy can be stale (a cancelled run can claim without recording).
  const semaphore = runtime.createPreviewSemaphoreResourceClient();
  const holder = pullRequestHolder(context.pullRequestNumber);
  const heldSlots = await listSlotsLeasedToHolder(semaphore, holder);
  const draftPolicy = decideDraftPreviewPolicy({
    allowDraft: options.allowDraft === true,
    holdsSlot: heldSlots.length > 0,
    isDraft: context.pullRequestIsDraft,
    labels: context.pullRequestLabels,
  });
  if (draftPolicy === "skip") {
    logPreview(
      `draft PR without the ${previewOptInLabel} label — not claiming a preview slot (mark ready, add the label, or pass --allow-draft)`,
    );
    const update = await updatePreviewState(context, (state) => ({
      ...state,
      notice: draftPreviewNotice,
    }));
    return {
      ok: true,
      skipped: true,
      skippedReason: "draft",
      state: update.state,
    };
  }
  if (draftPolicy === "teardown") {
    logPreview(
      `draft PR without the ${previewOptInLabel} label holds ${heldSlots.map((slot) => slot.slug).join(", ")} — tearing down and releasing the slot (mark ready, add the label, or pass --allow-draft to keep previews)`,
    );
    const cleanupResult = await cleanupPreviewForPullRequest({ ...runtime, context });
    if (!cleanupResult.ok) {
      // ok=false means the lease RELEASE failed (a failed teardown alone
      // still releases and reports ok — see cleanupPreviewForPullRequest).
      throw new Error("Failed to release the draft PR's preview slot lease.");
    }
    // Pin the post-teardown state in this write: the GitHub read inside
    // updatePreviewState can be stale (read-after-write lag) and would
    // otherwise resurrect the released lease and app rows — and this run's
    // test step would then re-acquire the slot the draft just gave up.
    const update = await updatePreviewState(context, (state) => ({
      ...state,
      ...cleanupResult.state,
      notice: draftPreviewNotice,
    }));
    return {
      ok: true,
      skipped: true,
      skippedReason: "draft",
      releasedLease: cleanupResult.released,
      state: update.state,
    };
  }

  const selectedApps = options.allApps
    ? (logPreview("--all-apps: deploying the full preview fleet regardless of diff"),
      Object.values(cloudflarePreviewApps))
    : await selectPreviewAppsForPullRequest({
        ...context,
        previousState: current.state,
      });

  if (selectedApps.length === 0) {
    logPreview(
      "nothing to deploy: no preview apps are affected by this diff, no failed apps need a retry, and every recorded app is still serving — leaving lease and PR body untouched",
    );
    return {
      ok: true,
      skipped: true,
      state: current.state,
    };
  }
  logPreview(
    `deploy plan: ${orderPreviewDeployBatches(selectedApps)
      .map((batch) => `[${batch.map((app) => app.slug).join(", ")}]`)
      .join(" then ")}`,
  );

  const requestedEnvironment = resolveRequestedPreviewEnvironment(context.pullRequestBody);
  if (requestedEnvironment) {
    logPreview(`PR body requests ${requestedEnvironment}`);
  }

  let leaseClaim: {
    lease: EnvironmentConfigLease;
    stackWasDestroyed: boolean;
  };
  try {
    const recordedLease = current.state.environmentConfigLease;
    leaseClaim = requestedEnvironment
      ? await assignEnvironmentConfigLease({
          destroyEnvironment: makePreviewEnvironmentDestroyer(runtime),
          holder,
          leaseMs: defaultPreviewLeaseMs,
          recordedLease,
          semaphore,
          wantedSlug: requestedEnvironment,
        })
      : await claimEnvironmentConfigLease({
          destroyEnvironment: makePreviewEnvironmentDestroyer(runtime),
          holder,
          leaseMs: defaultPreviewLeaseMs,
          // Surface the wait in the PR body the moment every slot is busy, not
          // only in workflow logs nobody has open.
          onFirstWait: async (holderTable) => {
            await updatePreviewState(context, (state) => ({
              ...state,
              notice: [
                `All preview slots are leased — this PR is waiting in line for one (since ${new Date().toISOString()}).`,
                holderTable,
              ].join("\n"),
            }));
          },
          recordedLease,
          semaphore,
          waitTotalMs: resolveSlotWaitTotalMs(runtime.commandEnvironment),
        });
  } catch (error) {
    await updatePreviewState(context, (state) => ({
      ...state,
      notice: `No preview slot could be claimed at ${new Date().toISOString()}. ${formatPreviewErrorMessage(error)}`,
    }));
    throw error;
  }
  const environmentConfigLease = leaseClaim.lease;
  // A handed-over slot has just had its whole Alchemy stack destroyed. Recreating it
  // gives D1/KV/R2 new identities, so every Worker must regenerate its config.
  // The signal is explicit because a lapsed lease can reclaim and destroy the
  // same slug. An uninterrupted same-stack deploy remains incremental.
  const previousSlug = current.state.environmentConfigLease?.slug ?? null;
  const appsToDeploy = leaseClaim.stackWasDestroyed
    ? Object.values(cloudflarePreviewApps)
    : selectedApps;
  if (leaseClaim.stackWasDestroyed) {
    logPreview(
      `${environmentConfigLease.slug} data stack was recreated: redeploying the full fleet against its fresh resource IDs`,
    );
  }
  // A successful claim clears exhaustion/takeover banners; a slot move
  // leaves its own so the change is impossible to miss.
  const claimNotice = describePreviewSlotChange({
    changedAt: new Date().toISOString(),
    nextSlug: environmentConfigLease.slug,
    previousSlug,
    requestedEnvironment,
  });
  const leaseUpdate = await updatePreviewState(context, (state) => ({
    ...state,
    environmentConfigLease: toLeaseReference(environmentConfigLease),
    notice: claimNotice,
  }));

  logPreview(`provisioning ${environmentConfigLease.dopplerConfig} data stack with Alchemy`);
  const infrastructure = await runCommand({
    command: "pnpm",
    args: ["infra", "deploy", "--env", environmentConfigLease.dopplerConfig],
    environment: runtime.commandEnvironment,
    signal: runtime.signal,
    workingDirectory: runtime.repositoryRoot,
  });
  if (infrastructure.exitCode !== 0) {
    throw new Error(
      commandFailureMessage(
        infrastructure,
        `Alchemy provisioning failed for ${environmentConfigLease.dopplerConfig}.`,
      ),
    );
  }

  // Both are read-only GitHub lookups, so overlap them before starting the
  // deploy fleet. A missing size baseline only costs the "vs main" delta;
  // uncertainty about container inputs safely chooses Wrangler's full rollout.
  const [workerSizeBaselines, osContainerRollout] = await Promise.all([
    fetchMainWorkerSizeBaselines(context).catch((error): Record<string, WorkerSizeInfo> => {
      logPreview(`worker-size baselines unavailable: ${formatPreviewErrorMessage(error)}`);
      return {};
    }),
    appsToDeploy.some((app) => app.slug === "os")
      ? resolvePreviewOsContainerRollout({
          dopplerConfig: environmentConfigLease.dopplerConfig,
          githubToken: context.githubToken,
          nextSlotSlug: environmentConfigLease.slug,
          previousSlotSlug: previousSlug,
          previousState: current.state,
          pullRequestHeadSha: context.pullRequestHeadSha,
          repositoryFullName: context.repositoryFullName,
        })
      : Promise.resolve(null),
  ]);
  if (osContainerRollout) {
    logPreview(`OS container rollout: ${osContainerRollout.mode} — ${osContainerRollout.reason}`);
  }

  let ok = true;
  let latestState = leaseUpdate.state;
  // Pin the lease, notice, and every batch's entries in each write: the
  // GitHub read inside updatePreviewState can be stale (read-after-write
  // lag), and a stale read would otherwise drop earlier batch results or
  // resurrect a pre-claim "waiting for a slot" banner.
  const accumulatedEntries: Record<string, CloudflarePreviewAppEntry> = {};
  for (const batch of orderPreviewDeployBatches(appsToDeploy)) {
    const completedDeploys = await mapWithConcurrency(
      batch,
      defaultPreviewDeployConcurrency,
      async (app) => {
        const entry = await deployPreviewAppWithStatus({
          app,
          existingEntry: current.state.apps[app.slug] ?? null,
          commandEnvironment: {
            ...runtime.commandEnvironment,
            // apps/os/scripts/deploy.ts turns this into
            // APP_CONFIG_ITERATE_REPO_PKG_REF so project seeds and dynamic
            // builds pin every iterate/iterate pkg.pr.new dependency to this
            // head's builds, not @main. The sha, not @<pr>: pkg.pr.new PR refs
            // are moving targets, while the sha pins the exact builds this
            // deploy shipped.
            PREVIEW_PULL_REQUEST_HEAD_SHA: context.pullRequestHeadSha,
            ...(app.slug === "os" && osContainerRollout
              ? { OS_CONTAINERS_ROLLOUT: osContainerRollout.mode }
              : {}),
          },
          dopplerConfig: environmentConfigLease.dopplerConfig,
          mainWorkerSize: workerSizeBaselines[app.slug] ?? null,
          pullRequestHeadSha: context.pullRequestHeadSha,
          repositoryRoot: runtime.repositoryRoot,
          runUrl: context.workflowRunUrl,
          signal: runtime.signal,
        });
        // Capture this before waiting for slower siblings in the batch. The
        // lane timestamp must describe this app's own completion, not the tail
        // of the concurrent deploy fleet.
        return { entry, finishedAt: new Date().toISOString() };
      },
    );
    const entries = completedDeploys.map(({ entry }) => entry);
    if (entries.some((entry) => entry.status === "deploy-failed")) {
      ok = false;
    }

    for (const { entry, finishedAt } of completedDeploys) {
      accumulatedEntries[entry.appSlug] = entry;
      telemetry.deployAppFinished({
        app: entry.appSlug,
        finishedAt,
        slot: environmentConfigLease.slug,
        status: entry.status === "awaiting-tests" ? "passed" : "failed",
        durationMs: entry.deployDurationMs ?? 0,
        configDurationMs: entry.deployConfigDurationMs,
        commandDurationMs: entry.deployCommandDurationMs,
        readinessDurationMs: entry.deployReadinessDurationMs,
        reuseProofDurationMs: entry.deployReuseProofDurationMs,
        workerName: entry.deployedWorkerName,
        workerVersion: entry.deployedWorkerVersion,
      });
    }
    const update = await updatePreviewState(context, (state) => ({
      ...state,
      environmentConfigLease: toLeaseReference(environmentConfigLease),
      notice: claimNotice,
      apps: {
        ...state.apps,
        ...accumulatedEntries,
      },
    }));
    latestState = update.state;
  }

  const deployedEntries = Object.values(latestState.apps).filter(
    (entry) => entry.headSha === context.pullRequestHeadSha,
  );
  logPreview(
    [
      `deploy finished: ${deployedEntries.filter((entry) => entry.status === "awaiting-tests").length} ok, ${deployedEntries.filter((entry) => entry.status === "deploy-failed").length} failed (details in the PR body's preview section)`,
      ...deployedEntries.map(
        (entry) =>
          `  ${entry.appSlug}: ${entry.status}${entry.publicUrl ? ` ${entry.publicUrl}` : ""}`,
      ),
    ].join("\n"),
  );
  const result = {
    ok,
    state: latestState,
  };

  if (!result.ok) {
    throw new Error(
      "Failed to deploy Cloudflare preview apps — see per-app output above and the failure details in the PR body.",
    );
  }

  return result;
}

function resolvePreviewTestBaseUrlEnvironment({
  app,
  apps,
  requiredDeploymentHeadSha,
}: {
  app: CloudflarePreviewApp;
  apps: Partial<
    Record<CloudflarePreviewAppSlug, { headSha?: string | null; publicUrl?: string | null }>
  >;
  /** Targeted runs can require a fresh current-head deployment; full CI may reuse proven unchanged versions. */
  requiredDeploymentHeadSha?: string;
}): string[] {
  const requiredUrls = new Map<CloudflarePreviewAppSlug, string>();
  requiredUrls.set(app.slug, app.previewTestBaseUrlEnvVar);
  for (const [dependencySlug, environmentVariable] of Object.entries(
    app.previewTestDependencyBaseUrlEnvVars ?? {},
  )) {
    if (environmentVariable) {
      requiredUrls.set(CloudflarePreviewAppSlug.parse(dependencySlug), environmentVariable);
    }
  }

  const environment = [...requiredUrls].map(([appSlug, environmentVariable]) => {
    const entry = apps[appSlug];
    if (
      !entry?.publicUrl ||
      (requiredDeploymentHeadSha != null && entry.headSha !== requiredDeploymentHeadSha)
    ) {
      throw new Error(
        requiredDeploymentHeadSha == null
          ? `Cannot test ${app.slug}: ${environmentVariable} requires a recorded ${appSlug} deployment. Re-run preview deploy.`
          : `Cannot test ${app.slug}: ${environmentVariable} requires ${appSlug} deployed at head ${requiredDeploymentHeadSha.slice(0, 7)}. Re-run preview deploy.`,
      );
    }
    return `${environmentVariable}=${entry.publicUrl}`;
  });

  // APP_CONFIG_BASE_URL is the common runtime contract used by app-level
  // suites. Inject the same recorded origin here so tests do not reintroduce
  // a Doppler copy of repository-owned route data.
  const appEntry = apps[app.slug];
  if (app.previewTestBaseUrlEnvVar !== "APP_CONFIG_BASE_URL") {
    environment.splice(1, 0, `APP_CONFIG_BASE_URL=${appEntry!.publicUrl}`);
  }
  return environment;
}

type PreviewTestTargetRunner = "vitest" | "playwright";

function resolvePreviewTestTargetPlan(input: {
  grep?: string;
  repositoryRoot: string;
  runner: PreviewTestTargetRunner;
  target: string;
}) {
  const target = input.target.trim();
  if (!target || target.startsWith("-")) {
    throw new Error("A test target must be a non-empty path, not a CLI option.");
  }

  if (input.runner === "vitest") {
    return {
      args: [
        "e2e",
        "--project",
        "node",
        target,
        ...(input.grep ? ["--testNamePattern", input.grep] : []),
      ],
      command: "pnpm",
      runnerResultFiles: [],
      telemetryFile: resolve(input.repositoryRoot, "test-results/preview-target-vitest.json"),
      workingDirectory: resolve(input.repositoryRoot, "apps/os"),
    };
  }

  return {
    args: ["spec", target, ...(input.grep ? ["--grep", input.grep] : [])],
    command: "pnpm",
    runnerResultFiles: [resolve(input.repositoryRoot, "test-results/playwright-results.json")],
    telemetryFile: resolve(
      input.repositoryRoot,
      "test-results/preview-target-playwright-telemetry.json",
    ),
    workingDirectory: input.repositoryRoot,
  };
}

function resolvePreviewTestWorkerVersionOverrides(input: {
  apps: Partial<Record<CloudflarePreviewAppSlug, CloudflarePreviewAppEntry>>;
  appSlugs: readonly CloudflarePreviewAppSlugType[];
  dopplerConfig: string;
  /** Targeted runs can require a fresh current-head deployment; full CI pins the recorded unchanged version. */
  requiredDeploymentHeadSha?: string;
}): string {
  return renderCloudflareWorkerVersionOverrides(
    input.appSlugs.map((appSlug) => {
      const entry = input.apps[appSlug];
      const expectedWorkerName = cloudflarePreviewApps[appSlug].resolvePreviewAppConfig(
        input.dopplerConfig,
      ).workerName;
      if (
        entry == null ||
        (input.requiredDeploymentHeadSha != null &&
          entry.headSha !== input.requiredDeploymentHeadSha) ||
        entry.deployedWorkerName !== expectedWorkerName ||
        !entry.deployedWorkerVersion
      ) {
        throw new Error(
          input.requiredDeploymentHeadSha == null
            ? `Cannot test ${appSlug}: its exact ${expectedWorkerName} deployment identity is missing. Re-run preview deploy.`
            : `Cannot test ${appSlug}: its exact ${expectedWorkerName} deployment identity is missing or stale for head ${input.requiredDeploymentHeadSha.slice(0, 7)}. Re-run preview deploy.`,
        );
      }
      return {
        versionId: entry.deployedWorkerVersion,
        workerName: entry.deployedWorkerName,
      };
    }),
  );
}

function resolvePreviewRolloutRemainingSeconds(input: {
  appSlug: CloudflarePreviewAppSlugType;
  deployedAt?: string | null;
  nowMs?: number;
}) {
  const readyAtMs = resolvePreviewRolloutReadyAtMs(input);
  if (readyAtMs === 0) return 0;

  return Math.ceil(Math.max(0, readyAtMs - (input.nowMs ?? Date.now())) / 1_000);
}

function resolvePreviewRolloutReadyAtMs(input: {
  appSlug: CloudflarePreviewAppSlugType;
  deployedAt?: string | null;
}) {
  if (!cloudflarePreviewApps[input.appSlug].previewTestRolloutGate || !input.deployedAt) return 0;

  const deployedAtMs = Date.parse(input.deployedAt);
  if (!Number.isFinite(deployedAtMs)) {
    throw new Error(`Invalid preview deployment timestamp: ${input.deployedAt}`);
  }

  return deployedAtMs + previewMinimumDeploymentAgeMs;
}

async function testPreviewApps({
  context,
  runtime,
  state: knownState,
  telemetry,
}: {
  context: PullRequestPreviewContext;
  runtime: PreviewRuntime;
  telemetry: PreviewE2eTelemetryArtifact;
  /**
   * In-process state from a just-finished deploy (the `run` path). A fresh
   * PR-body read can lag deploy's write (GitHub read-after-write lag) and
   * would miss entries deploy just recorded; the shared state cannot.
   * Standalone `test` reads the PR body instead.
   */
  state?: CloudflarePreviewState;
}) {
  logPreview(
    `test for PR #${context.pullRequestNumber} (head ${context.pullRequestHeadSha.slice(0, 7)}) — holder ${pullRequestHolder(context.pullRequestNumber)}, semaphore ${defaultSemaphoreBaseUrl}`,
  );
  const recorded = knownState ?? (await readCloudflarePreviewState(context)).state;

  // Semaphore is the single source of lease truth: resolve ownership FIRST by
  // renewing the PR body's exact fencing token. The recorded fields never
  // authorize tests by themselves.
  const holder = pullRequestHolder(context.pullRequestNumber);
  const semaphore = runtime.createPreviewSemaphoreResourceClient();
  const displaySlot = recorded.environmentConfigLease;
  const environmentConfigLease = await renewRecordedEnvironmentConfigLease({
    holder,
    leaseMs: defaultPreviewLeaseMs,
    recordedLease: displaySlot,
    semaphore,
  });
  if (!environmentConfigLease) {
    const hasTestableRecordedApps = Object.values(recorded.apps).some((entry) =>
      canRunPreviewTests(entry),
    );
    if (!displaySlot && !hasTestableRecordedApps) {
      const message = `Refusing to report preview e2e success: the semaphore leases no slot to ${holder} and no runnable deployment is recorded. E2e was NOT run. Run preview deploy first.`;
      logPreview(message);
      await updatePreviewState(context, (state) => ({ ...state, notice: message }));
      throw new Error(message);
    }

    // This PR has deployments on record but no slot: the slot was stolen (or
    // lapsed and taken). Testing would hammer someone else's deployment, and
    // skipping would hide the steal — refuse loudly instead.
    const message = describeLostSlotOwnership({
      currentHolder: displaySlot
        ? await findEnvironmentConfigLeaseHolder(semaphore, displaySlot.slug)
        : null,
      displaySlot,
      holder,
    });
    // Keep the recorded slot visible under the notice so a human sees WHERE
    // the takeover happened. Current-head apps are marked
    // claim-failed so deploy's retry selection redeploys them; the next test
    // run consults the semaphore again, so nothing written here can cause a
    // skip.
    await updatePreviewState(context, (state) => ({
      ...state,
      notice: `${message} E2e was NOT run. Re-run preview deploy to claim a slot and redeploy.`,
      apps: Object.fromEntries(
        Object.entries(state.apps).map(([appSlug, entry]) => [
          appSlug,
          // Older-head entries are already superseded; only current-head
          // entries are marked so deploy's retry selection picks them up.
          entry.headSha === context.pullRequestHeadSha
            ? {
                ...entry,
                status: "claim-failed" as const,
                message,
                updatedAt: new Date().toISOString(),
              }
            : entry,
        ]),
      ),
    }));
    throw new Error(
      `Refusing to run preview tests: ${message} Re-run "pnpm preview deploy" to claim a slot and redeploy.`,
    );
  }
  // Keep the PR's exact renewable lease reference in step with reality.
  if (
    displaySlot?.slug !== environmentConfigLease.slug ||
    displaySlot?.dopplerConfig !== environmentConfigLease.dopplerConfig
  ) {
    await updatePreviewState(context, (state) => ({
      ...state,
      environmentConfigLease: toLeaseReference(environmentConfigLease),
    }));
  }

  const testableApps = selectPreviewAppsForTesting(recorded.apps);

  if (testableApps.length === 0) {
    const notice = `Refusing to report preview e2e success for head ${context.pullRequestHeadSha.slice(0, 7)}: no runnable app deployment is recorded. E2e was NOT run. Run preview deploy first.`;
    logPreview(notice);
    await updatePreviewState(context, (state) => ({
      ...state,
      notice,
    }));
    throw new Error(notice);
  }
  logPreview(
    `testable apps for head ${context.pullRequestHeadSha.slice(0, 7)}: ${testableApps
      .map((app) => {
        const deployedHead = recorded.apps[app.slug]?.headSha;
        return `${app.slug}@${deployedHead?.slice(0, 7) ?? "unknown"}`;
      })
      .join(", ")}`,
  );
  const workerVersionOverrides = resolvePreviewTestWorkerVersionOverrides({
    apps: recorded.apps,
    appSlugs: testableApps.map((app) => app.slug),
    dopplerConfig: environmentConfigLease.dopplerConfig,
  });

  // Preview e2e commands are full app-level suites. They run concurrently:
  // each app deploys its own workers, and the non-OS suites are seconds-long
  // smokes whose load is negligible next to the OS lanes.
  const maybeEntries = await mapWithConcurrency(testableApps, testableApps.length, async (app) => {
    const existingEntry = recorded.apps[app.slug];
    if (!existingEntry?.publicUrl) {
      return null;
    }

    const baseUrlEnvironment = resolvePreviewTestBaseUrlEnvironment({
      app,
      apps: recorded.apps,
    });
    const rolloutDeploymentTimestamp = existingEntry.deployedAt ?? existingEntry.updatedAt;
    const rolloutRemainingSeconds = resolvePreviewRolloutRemainingSeconds({
      appSlug: app.slug,
      // Entries written before deployedAt existed fall back to their last
      // recorded transition. That may wait conservatively on one legacy
      // rerun, but it cannot release a genuinely fresh deployment early.
      deployedAt: rolloutDeploymentTimestamp,
    });
    const rolloutReadyAtMs = resolvePreviewRolloutReadyAtMs({
      appSlug: app.slug,
      deployedAt: rolloutDeploymentTimestamp,
    });

    const startedAt = Date.now();
    const telemetryArtifactDirectory = runtime.commandEnvironment.TEST_TELEMETRY_ARTIFACT_DIR
      ? resolve(runtime.repositoryRoot, runtime.commandEnvironment.TEST_TELEMETRY_ARTIFACT_DIR)
      : undefined;
    telemetry.appStarted(app.previewTestArtifactSources);
    if (app.previewTestRolloutGate === "before-suite" && rolloutRemainingSeconds > 0) {
      logPreview(
        `rollout settle start: ${app.slug} (${rolloutRemainingSeconds}s remaining from deployment)`,
      );
      await sleep(rolloutRemainingSeconds * 1_000, runtime.signal);
      logPreview(`rollout settle finish: ${app.slug}`);
    }
    logPreview(
      `test start: ${app.slug} against ${existingEntry.publicUrl} (doppler config ${environmentConfigLease.dopplerConfig})`,
    );
    // One attempt, deliberately: retries live in the individual test
    // (docs/testing.md#retries-and-timeouts) — everything above only
    // watches and fails.
    const testResult = await runCommand({
      args: [
        "run",
        "--project",
        app.dopplerProject,
        "--config",
        environmentConfigLease.dopplerConfig,
        "--",
        "env",
        `${E2E_CLOUDFLARE_WORKERS_VERSION_OVERRIDES_ENV}=${workerVersionOverrides}`,
        ...(app.previewTestRolloutGate === "inside-suite"
          ? [
              `${previewRolloutRemainingSecondsEnvironment}=${rolloutRemainingSeconds}`,
              `${PREVIEW_APP_ROLLOUT_READY_AT_MS_ENV}=${rolloutReadyAtMs}`,
            ]
          : []),
        ...baseUrlEnvironment,
        ...app.previewTestCommandArgs,
      ],
      command: "doppler",
      environment: {
        ...runtime.commandEnvironment,
        ...resolvePreviewTestTelemetryEnvironment({
          app: app.slug,
          context,
          previewSlot: environmentConfigLease.slug,
        }),
        ...(telemetryArtifactDirectory
          ? { TEST_TELEMETRY_ARTIFACT_DIR: telemetryArtifactDirectory }
          : {}),
      },
      signal: runtime.signal,
      workingDirectory: resolve(runtime.repositoryRoot, app.appPath),
    });
    const testDurationMs = Date.now() - startedAt;

    // Collected pass or fail. A green command without a complete structured
    // report is not a green observability proof: it would silently bias every
    // PostHog latency query toward whichever lanes happened to report.
    const testSummary = await app.collectTestTelemetry({
      repositoryRoot: runtime.repositoryRoot,
    });
    announceRetryTelemetry(app.slug, testSummary);
    const incompleteTelemetry = testSummary.collectionErrors.length
      ? `Structured e2e telemetry was incomplete: ${testSummary.collectionErrors.join("; ")}`
      : null;
    const testFailure =
      previewTestFailureMessage({ result: testResult, retrySummary: testSummary }) ??
      incompleteTelemetry;
    telemetry.appFinished({
      app: app.slug,
      slot: environmentConfigLease.slug,
      status: testFailure ? "failed" : "passed",
      durationMs: testDurationMs,
      exitCode: testResult.exitCode,
      testCount: testSummary.testCount,
      retryCount: testSummary.retried.reduce((total, test) => total + test.retryCount, 0),
      collectionErrors: testSummary.collectionErrors,
    });
    console.error(
      `[preview] test ${testFailure ? "failed" : "passed"}: ${app.slug} (${formatDurationMs(testDurationMs)})`,
    );
    if (!testFailure) {
      warnIfOverBudget("e2e", app.slug, testDurationMs, app.previewTestBudgetMs);
    }

    return CloudflarePreviewAppEntry.parse({
      ...existingEntry,
      appDisplayName: app.displayName,
      appSlug: app.slug,
      message: testFailure,
      runUrl: context.workflowRunUrl ?? existingEntry.runUrl ?? null,
      status: testFailure ? "tests-failed" : "deployed",
      testDurationMs,
      testRetries: renderPreviewRetrySummary(testSummary),
      updatedAt: new Date().toISOString(),
    } satisfies CloudflarePreviewAppEntry);
  });
  const entries = maybeEntries.filter((entry): entry is CloudflarePreviewAppEntry => entry != null);

  const ok = !entries.some((entry) => entry.status === "tests-failed");
  logPreview(
    [
      `tests finished: ${entries.filter((entry) => entry.status === "deployed").length} passed, ${entries.filter((entry) => entry.status === "tests-failed").length} failed`,
      ...entries.map((entry) => `  ${entry.appSlug}: ${entry.status}`),
    ].join("\n"),
  );
  if (entries.length > 0) {
    const update = await updatePreviewState(context, (state) => ({
      ...state,
      apps: {
        ...state.apps,
        ...Object.fromEntries(entries.map((entry) => [entry.appSlug, entry])),
      },
    }));
    const result = {
      ok,
      state: update.state,
    };

    if (!result.ok) {
      throw new Error(
        "Preview tests failed — see per-app output above and the failure details in the PR body.",
      );
    }

    return result;
  }

  const result = {
    ok,
    state: recorded,
  };

  if (!result.ok) {
    throw new Error(
      "Preview tests failed — see per-app output above and the failure details in the PR body.",
    );
  }

  return result;
}

/**
 * Tear down deployed apps recorded in the managed PR preview section and release the environment config lease.
 */
export async function cleanup(options: PullRequestCommandOptions = {}) {
  const runtime = createPreviewRuntime();
  const result = await cleanupPreviewForPullRequest({
    ...runtime,
    context: await resolvePullRequestPreviewContext({
      commandEnvironment: runtime.commandEnvironment,
      githubToken: resolveGithubToken(options, runtime.commandEnvironment),
      pullRequestNumber: resolvePullRequestNumber(options, runtime.commandEnvironment),
    }),
  });

  // Exit-code contract (the only consumer is the cleanup workflow's
  // red/green — nothing gates on it): exit non-zero ONLY when the lease
  // RELEASE failed, because a held lease leaks the slot until expiry and
  // constrains the fleet. A failed teardown alone exits zero with a loud
  // warning: the lease was released, environment-manager still exposes the
  // non-empty/failed lifecycle to hourly GC, and every acquire destroys it
  // before reuse.
  if (!result.ok) {
    throw new Error(
      "Failed to release the preview slot lease — it leaks until expiry. Re-run cleanup, or free it with `pnpm preview release --slot <N> --force`.",
    );
  }
  if (result.teardownFailed) {
    logPreview(
      "cleanup exits 0 despite the failed teardown: the lease was released and environment-manager retains the cleanup obligation for hourly GC",
    );
  }

  return result;
}

/**
 * Assign a preview slot to a PR — a specific slot or whatever is free — and record it in the PR body's managed preview section.
 */
type AssignOptions = PullRequestCommandOptions & {
  /** Preview slot: a number (3) or slug (preview-3 / preview_3). Omit to take any free slot. */
  slot?: string;
  /** Evict the slot's current holder first. Their deployment on the slot will be clobbered. */
  force?: boolean;
};

export async function assign(options: AssignOptions = {}) {
  const runtime = createPreviewRuntime();
  const context = await resolvePullRequestPreviewContext({
    commandEnvironment: runtime.commandEnvironment,
    githubToken: resolveGithubToken(options, runtime.commandEnvironment),
    pullRequestNumber: resolvePullRequestNumber(options, runtime.commandEnvironment),
  });
  const semaphore = runtime.createPreviewSemaphoreResourceClient();
  const holder = pullRequestHolder(context.pullRequestNumber);
  const wantedSlug = options.slot ? normalizePreviewSlotSlug(options.slot) : null;
  logPreview(
    `assign for PR #${context.pullRequestNumber} — ${wantedSlug ? `wants ${wantedSlug}` : "wants any free slot"}, holder ${holder}`,
  );

  const current = await readCloudflarePreviewState(context);
  const result = await assignEnvironmentConfigLease({
    destroyEnvironment: makePreviewEnvironmentDestroyer(runtime),
    force: options.force,
    holder,
    leaseMs: defaultPreviewLeaseMs,
    recordedLease: current.state.environmentConfigLease,
    semaphore,
    wantedSlug,
  });

  // Anything but a kept/renewed lease breaks continuous ownership: even a
  // re-acquisition of the SAME slug means someone else may have deployed over
  // this PR's apps in the interim, so recorded deployments cannot be trusted.
  const needsRedeploy = result.stackWasDestroyed || result.outcome !== "kept";
  const redeployMessage = result.changedFromSlug
    ? `Slot reassigned from ${result.changedFromSlug} to ${result.lease.slug}; run preview deploy to redeploy here.`
    : `Slot ${result.lease.slug} was re-acquired after this PR's lease lapsed — previous deployments there may have been replaced. Run preview deploy to redeploy.`;
  const update = await updatePreviewState(context, (state) => ({
    ...state,
    environmentConfigLease: toLeaseReference(result.lease),
    notice: needsRedeploy
      ? `${redeployMessage} (preview assign at ${new Date().toISOString()})`
      : null,
    apps: needsRedeploy
      ? Object.fromEntries(
          Object.entries(state.apps).map(([appSlug, entry]) => [
            appSlug,
            {
              ...entry,
              status: "claim-failed" as const,
              message: redeployMessage,
              updatedAt: new Date().toISOString(),
            },
          ]),
        )
      : state.apps,
  }));
  logPreview(
    `PR body updated: PR #${context.pullRequestNumber} now records ${result.lease.slug} (doppler config ${result.lease.dopplerConfig})`,
  );

  return {
    pullRequestNumber: context.pullRequestNumber,
    slot: result.lease.slug,
    dopplerConfig: result.lease.dopplerConfig,
    holder,
    leasedUntil: new Date(result.lease.leasedUntil).toISOString(),
    outcome: result.outcome,
    previousSlot: result.changedFromSlug,
    previousLeaseReleased: result.previousLeaseReleased,
    appsMarkedForRedeploy: needsRedeploy ? Object.keys(update.state.apps) : [],
    nextStep: `doppler run --project _shared --config prd -- pnpm preview deploy --pull-request-number ${context.pullRequestNumber}`,
  };
}

/**
 * Show environment config lease inventory, cross-check holders against GitHub
 * PR state, and explain why the fleet can look full even when only a handful
 * of PRs are open (orphaned closed-PR leases, idle holds, draft opt-ins, …).
 *
 *   doppler run --project _shared --config prd -- pnpm preview status
 */
type StatusOptions = {
  /** GitHub token. Defaults to GITHUB_TOKEN or `gh auth token`. */
  githubToken?: string;
  /** Hours without a deploy/test renewal before a hold counts as idle. */
  minIdleHours?: number;
};

export async function status(options: StatusOptions = {}) {
  const runtime = createPreviewRuntime();
  const semaphore = runtime.createPreviewSemaphoreResourceClient();
  const { githubToken, repositoryFullName, fetchPullRequestState } = resolvePreviewGithubContext(
    runtime,
    options,
  );
  if (!fetchPullRequestState) {
    logPreview(
      "no GITHUB_TOKEN / gh auth — cannot check whether pr-* holders are closed or list open PRs; lease table is still live from the semaphore",
    );
  }

  const minIdleHours = options.minIdleHours ?? defaultReclaimMinIdleHours;
  const slots = await classifyEnvironmentConfigLeases({
    fetchPullRequestState,
    minIdleMs: minIdleHours * 3_600_000,
    semaphore,
  });
  const openPullRequests = githubToken
    ? await listOpenPullRequestsForPreviewDiagnosis(githubToken, repositoryFullName)
    : [];
  const diagnosis = diagnosePreviewFleetCapacity({ openPullRequests, slots });

  return {
    checkedAt: new Date().toISOString(),
    semaphoreBaseUrl: defaultSemaphoreBaseUrl,
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
    total: slots.length,
    availableCount: diagnosis.availableCount,
    leasedCount: diagnosis.leasedCount,
    minIdleHours,
    nextLeaseExpiryAt: diagnosis.nextLeaseExpiryAt,
    slots,
    openPullRequests: openPullRequests.map((pullRequest) => ({
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.url,
      isDraft: pullRequest.isDraft,
      labels: pullRequest.labels,
      previewEligible: pullRequestWouldClaimPreviewSlot(pullRequest),
      holdsSlot: diagnosis.holdersWithOpenPrs.includes(pullRequest.number),
    })),
    diagnosis,
    // Surface reclaim commands at the top level too, matching `reclaim`'s own
    // output shape. Must be a fresh array: the trpc-cli renderer prints any
    // value it has already seen elsewhere in the tree (here, the same array
    // under `diagnosis.reclaimCommands`) as the literal string "[Circular]",
    // even though it is only shared, not truly cyclic.
    reclaimable: [...diagnosis.reclaimCommands],
    note: diagnosis.summary,
  };
}

/**
 * Lease a specific preview slot for manual deploys so PR previews cannot deploy over it and PR cleanup cannot destroy it.
 */
type AcquireOptions = {
  /** Preview slot: a number (9) or slug (preview-9 / preview_9). */
  slot: string;
  /** Manual lease length in hours. */
  hours?: number;
  /** Holder recorded on the lease. Defaults to manual-<username>. */
  as?: string;
  /** Evict the current holder. Their deployment on the slot will be clobbered by whatever you deploy. */
  force?: boolean;
};

export async function acquire(options: AcquireOptions) {
  const runtime = createPreviewRuntime();
  const semaphore = runtime.createPreviewSemaphoreResourceClient();
  const slug = normalizePreviewSlotSlug(options.slot);
  const holder = options.as?.trim() || `manual-${userInfo().username}`;

  if (options.force) {
    const currentHolder = await findEnvironmentConfigLeaseHolder(semaphore, slug);
    if (currentHolder) {
      logPreview(
        `--force: evicting ${currentHolder} from ${slug}. Their deployment on the slot is now fair game.`,
      );
    }
  }

  const lease = await semaphore.acquireSpecific({
    allowedSlugs: previewEnvironmentSlugs,
    leaseMs: (options.hours || 3) * 3_600_000,
    slug,
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
    holder,
    force: options.force,
  });
  if (!lease) {
    const currentHolder = await findEnvironmentConfigLeaseHolder(semaphore, slug);
    if (currentHolder) {
      const prUrl = holderPullRequestUrl(currentHolder);
      throw new Error(
        [
          `${slug} is leased by ${currentHolder}${prUrl ? ` (${prUrl})` : ""}.`,
          `Re-run with --force to evict them (their deployment will be clobbered), or pick a free slot:`,
          await describeEnvironmentConfigLeases(semaphore),
        ].join("\n"),
      );
    }

    throw new Error(
      [
        `${slug} is not a known preview slot. Known slots:`,
        await describeEnvironmentConfigLeases(semaphore),
      ].join("\n"),
    );
  }

  return {
    ...lease,
    holder,
    expiresAt: new Date(lease.expiresAt).toISOString(),
    releaseCommand: `pnpm preview release --slot ${slug} --lease-id ${lease.leaseId}`,
  };
}

/**
 * Release a preview slot lease. Pass the lease id from `preview acquire`, or
 * --force to release someone else's stale lease. This does not destroy the
 * environment: environment-manager's non-empty lifecycle remains visible to
 * GC, and a later tenant destroys before deployment. Use `preview reclaim
 * --slot N` to take back and destroy immediately.
 */
type ReleaseOptions = {
  /** Preview slot: a number (9) or slug (preview-9 / preview_9). */
  slot: string;
  /** Lease id returned by `pnpm preview acquire`. Not needed with --force. */
  leaseId?: string;
  /** Release whatever lease is on the slot, without its lease id. Only for freeing stale/abandoned holds. */
  force?: boolean;
};

export async function release(options: ReleaseOptions) {
  const runtime = createPreviewRuntime();
  const semaphore = runtime.createPreviewSemaphoreResourceClient();
  const slug = normalizePreviewSlotSlug(options.slot);
  if (!options.leaseId && !options.force) {
    throw new Error(
      "Pass --lease-id <id> (from `preview acquire`), or --force to release a lease you don't hold.",
    );
  }

  const currentHolder = await findEnvironmentConfigLeaseHolder(semaphore, slug);
  if (options.force && currentHolder) {
    logPreview(`--force: releasing ${slug} out from under ${currentHolder}.`);
  }

  const result = await semaphore.release({
    leaseId: options.leaseId,
    slug,
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
    force: options.force,
  });
  if (!result.released) {
    if (!currentHolder) {
      return { released: false, slug, message: `${slug} was not leased — nothing to release.` };
    }

    const prUrl = holderPullRequestUrl(currentHolder);
    throw new Error(
      `Semaphore did not release ${slug}: it is leased by ${currentHolder}${prUrl ? ` (${prUrl})` : ""} and your leaseId doesn't match. Use --force only if that hold is stale.`,
    );
  }

  return { released: true, slug, evictedHolder: currentHolder };
}

function requireExplicitReclaimForce(
  slot: {
    holder: string | null;
    lastUsedAgo: string | null;
    leasedUntil: string | null;
    pullRequestUrl: string | null;
    slug: string;
    verdict: "active" | "available" | "idle" | "orphaned";
  },
  force: boolean | undefined,
) {
  if (force) return;

  throw new Error(
    [
      `${slot.slug} is ${slot.verdict} and still leased by ${slot.holder ?? "unknown holder"}${slot.pullRequestUrl ? ` (${slot.pullRequestUrl})` : ""}:`,
      `  last used ${slot.lastUsedAgo ?? "recently"}, lease expires ${slot.leasedUntil ?? "soon"}.`,
      "Taking it would ERASE the slot's data and may race its owner's deploy or close-triggered cleanup.",
      "Re-run with --force only after verifying no deploy or cleanup is still running.",
    ].join("\n"),
  );
}

/** Report slot contention or explicitly reclaim a held slot after checking its lifecycle. */
type ReclaimOptions = {
  /** Preview slot to reclaim (number or slug). Omit for a report of every slot's verdict. */
  slot?: string;
  /** Hours without a deploy/test renewal before a hold counts as idle. */
  minIdleHours?: number;
  /** Required to evict any held slot after verifying no deploy or cleanup is still running. */
  force?: boolean;
  /** GitHub token used to check whether pr-N holders are closed. Defaults to GITHUB_TOKEN. */
  githubToken?: string;
};

export async function reclaim(options: ReclaimOptions = {}) {
  const runtime = createPreviewRuntime();
  const semaphore = runtime.createPreviewSemaphoreResourceClient();
  const { fetchPullRequestState } = resolvePreviewGithubContext(runtime, options);
  if (!fetchPullRequestState) {
    logPreview(
      "no GITHUB_TOKEN / gh auth — cannot check whether pr-* holders are closed, so verdicts are idle-time only (orphaned PRs show as idle/active)",
    );
  }

  const minIdleMs = (options.minIdleHours ?? defaultReclaimMinIdleHours) * 3_600_000;
  const report = await classifyEnvironmentConfigLeases({
    fetchPullRequestState,
    minIdleMs,
    semaphore,
  });

  if (!options.slot) {
    return {
      checkedAt: new Date().toISOString(),
      minIdleHours: options.minIdleHours ?? defaultReclaimMinIdleHours,
      slots: report,
      reclaimable: report
        .filter((slot) => slot.verdict === "orphaned" || slot.verdict === "idle")
        .map((slot) => `pnpm preview reclaim --slot ${slot.slug} --force`),
      note: "orphaned = holder PR is closed, so its cleanup may have failed; idle = holder hasn't deployed/tested for a while. Reclaiming ERASES the slot's data and always requires explicit --force after checking that no deploy or cleanup is running.",
    };
  }

  const slug = normalizePreviewSlotSlug(options.slot);
  const slot = report.find((candidate) => candidate.slug === slug);
  if (!slot) {
    throw new Error(`${slug} is not a known preview slot.`);
  }
  if (slot.verdict === "available") {
    return { released: false, slug, message: `${slug} is already available.` };
  }
  requireExplicitReclaimForce(slot, options.force);

  logPreview(
    `reclaiming ${slug} from ${slot.holder ?? "unknown holder"} (${slot.verdict}${slot.lastUsedAgo ? `, last used ${slot.lastUsedAgo}` : ""}) — destroying its environment before returning it to the pool`,
  );
  // Take the slot under OUR OWN fresh lease before destroying. The old holder's
  // lease could expire mid-destroy (the verdict is a snapshot), and destroying
  // data on a slot another PR just acquired would wreck an innocent tenant —
  // a fresh lease parks the slot for the whole operation. A destroy failure
  // leaves that lease in place (parked and visible in this report) and throws.
  const holder = `reclaim-${userInfo().username}`;
  const holdMs = defaultPreviewLeaseMs;
  const taken = await semaphore.acquireSpecific({
    allowedSlugs: previewEnvironmentSlugs,
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
    slug,
    leaseMs: holdMs,
    holder,
    force: true,
  });
  if (!taken) {
    throw new Error(`Could not take ${slug} from ${slot.holder ?? "its holder"} — retry.`);
  }
  await destroyEnvironmentUnderLease({
    destroyEnvironment: makePreviewEnvironmentDestroyer(runtime),
    dopplerConfig: slot.dopplerConfig,
    lease: taken,
    leaseMs: holdMs,
    semaphore,
    signal: runtime.signal,
  });
  const result = await semaphore.release({
    slug,
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
    leaseId: taken.leaseId,
  });
  if (!result.released) {
    throw new Error(`Lease ownership lost for ${slug} before reclaim could release it.`);
  }
  return {
    released: true,
    destroyed: true,
    slug,
    reclaimedFrom: slot.holder,
    verdict: slot.verdict,
  };
}

/** An environment-manager cleanup obligation with no live tenant. */
type PreviewEnvironmentForGc = {
  slug: string;
  holder: string | null;
  dopplerConfig: string;
};

type PreviewEnvironmentObservation =
  | { slug: string; state: EnvironmentState }
  | { slug: string; error: Error };

type PreviewEnvironmentGcSelection = {
  candidates: PreviewEnvironmentForGc[];
  failures: Array<{ slug: string; error: Error }>;
};

/**
 * Pure selection for {@link gc}: every non-empty environment-manager state
 * whose Semaphore lease is available or expired. Environment-manager is the
 * cleanup authority; Semaphore only determines whether it is safe to act.
 */
function selectPreviewEnvironmentsForGc(
  observations: ReadonlyArray<PreviewEnvironmentObservation>,
  leases: ReadonlyArray<{
    holder?: string | null;
    leaseState: "available" | "leased";
    leasedUntil: number | null;
    slug: string;
  }>,
  now: number,
): PreviewEnvironmentGcSelection {
  const leasesBySlug = new Map(leases.map((lease) => [lease.slug, lease]));
  const candidates: PreviewEnvironmentForGc[] = [];
  const failures: PreviewEnvironmentGcSelection["failures"] = [];
  for (const observation of observations) {
    const inventory = environmentConfigLeaseInventory.find(({ slug }) => slug === observation.slug);
    if (!inventory) {
      failures.push({
        slug: observation.slug,
        error: new Error(
          `GC received environment-manager status for unknown preview slot ${observation.slug}.`,
        ),
      });
      continue;
    }
    if ("error" in observation) {
      failures.push({ slug: inventory.slug, error: observation.error });
      continue;
    }
    if (observation.state.lifecycle === "empty") continue;

    const lease = leasesBySlug.get(inventory.slug);
    if (!lease) {
      failures.push({
        slug: inventory.slug,
        error: new Error(`GC found no Semaphore lease inventory for ${inventory.slug}.`),
      });
      continue;
    }
    if (lease.leaseState === "leased" && lease.leasedUntil === null) {
      failures.push({
        slug: inventory.slug,
        error: new Error(`GC found leased environment ${inventory.slug} without an expiry.`),
      });
      continue;
    }
    if (lease.leaseState === "leased" && lease.leasedUntil !== null && lease.leasedUntil > now) {
      continue;
    }
    candidates.push({
      slug: inventory.slug,
      holder: lease.holder ?? null,
      dopplerConfig: inventory.data.dopplerConfig,
    });
  }
  return { candidates, failures };
}

/** Report what would be destroyed without touching anything, or hold length. */
type GcOptions = {
  /** Print the plan without acquiring, destroying, or releasing anything. */
  dryRun?: boolean;
};

/**
 * Garbage-collect every non-empty managed preview environment without a live
 * tenant: take and continuously fence its lease, re-read manager state,
 * destroy it, and release it — unattended and sequential.
 *
 * The take is non-force, so a tenant that acquired or renewed after the
 * snapshot cannot be destroyed. A failed destroy stays durably visible in
 * environment-manager for the next hourly sweep; the lease is still released.
 */
export async function gc(options: GcOptions = {}) {
  const runtime = createPreviewRuntime();
  const semaphore = runtime.createPreviewSemaphoreResourceClient();
  const now = Date.now();
  const [observations, leases] = await Promise.all([
    Promise.all(
      environmentConfigLeaseInventory.map(async ({ data, slug }) => {
        try {
          return {
            slug,
            state: await runtime.readEnvironmentState(environmentStage(data.dopplerConfig)),
          } satisfies PreviewEnvironmentObservation;
        } catch (error) {
          return {
            slug,
            error: error instanceof Error ? error : new Error(String(error)),
          } satisfies PreviewEnvironmentObservation;
        }
      }),
    ),
    semaphore.list({ type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE }),
  ]);
  const selection = selectPreviewEnvironmentsForGc(observations, leases, now);
  const { candidates } = selection;
  const holdMs = defaultPreviewLeaseMs;
  const destroyEnvironment = makePreviewEnvironmentDestroyer(runtime);

  const outcomes: Array<{
    slug: string;
    action:
      | "acquire-failed"
      | "already-empty"
      | "destroyed"
      | "destroy-failed"
      | "release-failed"
      | "selection-failed"
      | "skipped"
      | "would-destroy";
    holder: string | null;
    error?: string;
  }> = [];
  const failures: unknown[] = selection.failures.map(({ error }) => error);
  for (const { slug, error } of selection.failures) {
    outcomes.push({
      slug,
      action: "selection-failed",
      holder: null,
      error: formatPreviewErrorMessage(error),
    });
  }
  for (const slot of candidates) {
    if (options.dryRun) {
      outcomes.push({ slug: slot.slug, action: "would-destroy", holder: slot.holder });
      continue;
    }
    let taken: PreviewSemaphoreLease | null;
    try {
      taken = await semaphore.acquireSpecific({
        allowedSlugs: previewEnvironmentSlugs,
        type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
        slug: slot.slug,
        leaseMs: holdMs,
        holder: "gc",
      });
    } catch (error) {
      failures.push(error);
      outcomes.push({
        slug: slot.slug,
        action: "acquire-failed",
        holder: slot.holder,
        error: formatPreviewErrorMessage(error),
      });
      continue;
    }
    if (!taken) {
      logPreview(`gc: ${slot.slug} was re-leased since the snapshot — leaving it to its tenant`);
      outcomes.push({ slug: slot.slug, action: "skipped", holder: slot.holder });
      continue;
    }
    try {
      logPreview(
        `gc: destroying managed environment ${slot.slug}${slot.holder ? ` after ${slot.holder}'s lease expired` : ""}`,
      );
      let alreadyEmpty = false;
      await withLeaseFence({
        lease: taken,
        leaseMs: holdMs,
        semaphore,
        signal: runtime.signal,
        operation: async (signal) => {
          const current = await runtime.readEnvironmentState(environmentStage(slot.dopplerConfig));
          if (current.lifecycle === "empty") {
            alreadyEmpty = true;
            return;
          }
          await destroyEnvironment({
            dopplerConfig: slot.dopplerConfig,
            signal,
            slug: slot.slug,
          });
        },
      });
      outcomes.push({
        slug: slot.slug,
        action: alreadyEmpty ? "already-empty" : "destroyed",
        holder: slot.holder,
      });
    } catch (error) {
      logPreview(
        `gc: destroy failed for ${slot.slug}; environment-manager retains it for the next sweep: ${error instanceof Error ? error.message : String(error)}`,
      );
      failures.push(error);
      outcomes.push({
        slug: slot.slug,
        action: "destroy-failed",
        holder: slot.holder,
        error: formatPreviewErrorMessage(error),
      });
    }
    try {
      const released = await semaphore.release({
        slug: slot.slug,
        type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
        leaseId: taken.leaseId,
      });
      if (!released.released) {
        throw new Error(`Lease ownership lost for ${slot.slug} before GC could release it.`);
      }
    } catch (error) {
      failures.push(error);
      outcomes.push({
        slug: slot.slug,
        action: "release-failed",
        holder: slot.holder,
        error: formatPreviewErrorMessage(error),
      });
    }
  }

  const destroyedCount = outcomes.filter((outcome) => outcome.action === "destroyed").length;
  logPreview(
    `gc: ${observations.length} managed environment(s), ${candidates.length} non-empty without a live tenant, ${destroyedCount} destroyed${options.dryRun ? " (dry-run — nothing destroyed)" : ""}`,
  );
  const result = {
    checkedAt: new Date(now).toISOString(),
    dryRun: options.dryRun ?? false,
    managedCount: observations.length,
    candidateCount: candidates.length,
    destroyedCount,
    outcomes,
  };
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Preview GC left ${failures.length} failed operation(s); environment-manager retains them for retry.`,
    );
  }
  return result;
}

/**
 * Check live Semaphore environment config leases against Doppler configs and Cloudflare preview domain zones.
 */
export async function reconcile() {
  const runtime = createPreviewRuntime();
  return await reconcileEnvironmentConfigLeaseResources({
    client: runtime.createPreviewSemaphoreResourceClient(),
    commandEnvironment: runtime.commandEnvironment,
    repositoryRoot: runtime.repositoryRoot,
    semaphoreBaseUrl: defaultSemaphoreBaseUrl,
  });
}

/**
 * Ensure preview auth, OS, and streams-example Doppler configs contain per-slot constants.
 */
type ProvisionAuthPreviewConfigsOptions = {
  /** Regenerate OAuth client secrets and app auth tokens instead of keeping existing values. */
  rotate?: boolean;
  /** Comma-separated preview slots or ranges, for example `10-19` or `10-12,19`. */
  slots?: string;
};

export async function provisionAuthPreviewConfigs(
  options: ProvisionAuthPreviewConfigsOptions = {},
) {
  const slots = resolveProvisionAuthPreviewSlotNumbers({
    availableSlots: previewEnvironmentSlotNumbers,
    slots: options.slots,
  });
  await ensureAuthPreviewConfigs({
    rotate: Boolean(options.rotate),
    slots,
  });

  return {
    rotated: Boolean(options.rotate),
    slots: slots.length,
  };
}

function resolveProvisionAuthPreviewSlotNumbers(input: {
  availableSlots: number[];
  slots: string | undefined;
}) {
  if (!input.slots) return input.availableSlots;

  const requestedSlots = input.slots.split(",").flatMap((segment) => {
    const trimmedSegment = segment.trim();
    const singleSlot = /^(\d+)$/.exec(trimmedSegment);
    if (singleSlot) return [Number(singleSlot[1])];

    const range = /^(\d+)-(\d+)$/.exec(trimmedSegment);
    if (!range) throw new Error(`Invalid preview slot selection ${JSON.stringify(segment)}`);

    const first = Number(range[1]);
    const last = Number(range[2]);
    if (last < first) {
      throw new Error(`Invalid descending preview slot range ${trimmedSegment}`);
    }
    return Array.from({ length: last - first + 1 }, (_, index) => first + index);
  });

  const uniqueSlots = [...new Set(requestedSlots)];
  for (const slot of uniqueSlots) {
    if (!input.availableSlots.includes(slot)) {
      throw new Error(`Cannot provision unknown preview slot ${slot}`);
    }
  }
  return uniqueSlots;
}

export const CloudflarePreviewAppSlug = z.enum([
  "os",
  "docs",
  "semaphore",
  "auth",
  "streams-example-app",
  "dummy-petshop",
]);

export type CloudflarePreviewAppSlug = z.infer<typeof CloudflarePreviewAppSlug>;
type CloudflarePreviewAppSlugType = CloudflarePreviewAppSlug;

export type CloudflarePreviewApp = {
  slug: CloudflarePreviewAppSlug;
  displayName: string;
  appPath: `apps/${string}`;
  /**
   * Run under `doppler run --project <p> --config preview_N --` in appPath;
   * every app exposes `deploy` (full deploy to the slot).
   */
  deployCommandArgs: readonly [string, ...string[]];
  dopplerProject: string;
  /**
   * Resolve the public URL and Worker script from the repo's typed envs.ts.
   * Deploy scripts consume that same map, so orchestration never forks the
   * deployment identity through a second config read.
   */
  resolvePreviewAppConfig: (dopplerConfig: string) => {
    baseUrl: string;
    projectHostnameBases?: string[];
    workerName: string;
  };
  paths: string[];
  /**
   * Skip this app's deploy when the slot already serves an identical build: a
   * prior recorded "deployed" entry whose publicUrl matches this slot and
   * whose fingerprint (git object ids of these paths at HEAD) is unchanged.
   * For fixture apps that almost never change (dummy-petshop) — the app's
   * e2e smoke still runs against the existing worker.
   */
  contentFingerprintPaths?: string[];
  /** Apps co-selected so this app deploys and tests against one coherent head. */
  previewDependencies?: CloudflarePreviewAppSlug[];
  /**
   * Public URLs of deployed preview dependencies that the app's e2e command
   * must receive. Values come from this PR's recorded deployment at the
   * current head; a missing/stale dependency fails the lane instead of
   * silently pointing at another environment.
   */
  previewTestDependencyBaseUrlEnvVars?: Partial<Record<CloudflarePreviewAppSlug, string>>;
  /** Readiness probe path on the app's public URL (default /api/__internal/health). */
  previewReadyUrlPath?: string;
  /**
   * Require the readiness route to report wrangler's newly deployed Worker
   * version before tests start. This is an edge-version barrier only: waking a
   * finite sample of Durable Objects cannot prove the whole fleet.
   */
  previewReadyWorkerVersion?: true;
  /**
   * Cloudflare Worker and Durable Object code propagation is eventually
   * consistent after deploy. Live suites that call a DO either wait before
   * their short command starts, or consume the absolute boundary inside a
   * longer command so independent setup can overlap it.
   */
  previewTestRolloutGate?: "before-suite" | "inside-suite";
  previewTestBaseUrlEnvVar: string;
  /** Every canonical artifact the app-level test command must produce once. */
  previewTestArtifactSources: readonly TestTelemetryArtifactSource[];
  previewTestCommandArgs: readonly [string, ...string[]];
  /**
   * Soft wall-clock budgets. When a phase runs slower than its budget we emit
   * a GitHub/Depot `::warning::` annotation (never fail) so preview CI creep
   * is visible on the PR — see docs/ci-preview-performance.md. Tune these when
   * a change legitimately shifts the floor; don't just bump them to silence a
   * regression.
   */
  previewDeployBudgetMs?: number;
  previewTestBudgetMs?: number;
  /**
   * Collect a runner-report test count and retry summary after the command.
   * A missing report is an explicit collection error: a green lane must not
   * silently disappear from latency analytics. Detailed records stay in the
   * canonical runner artifacts consumed by the workflow finalizer.
   */
  collectTestTelemetry: (params: { repositoryRoot: string }) => Promise<PreviewTestSummary>;
};

/**
 * Aggregated retry telemetry for one app's preview e2e lane: every test that
 * needed a re-roll, whichever sub-lane (TUI, Vitest, Playwright) it ran in.
 * Why this exists: a retry can preserve the first failure while still letting
 * the test finish successfully. The count and first failure keep flakes
 * visible without making an otherwise-green run fail.
 */
export type PreviewRetrySummary = {
  retried: {
    /** Which sub-lane observed the retry (e.g. "vitest", "specs"). */
    lane: string;
    name: string;
    retryCount: number;
    passedAfterRetry: boolean;
    firstFailure?: string;
  }[];
};

/** Immediate orchestration summary; detailed timing stays in canonical artifacts. */
export type PreviewTestSummary = PreviewRetrySummary & {
  testCount: number;
  collectionErrors: string[];
};

/**
 * Where the os lane tells the vitest RetryTelemetryReporter (see
 * packages/shared test-support/e2e-policy) to write its JSON. The lane
 * removes the file before running so a previous run on the same machine
 * (marathon loops) can't leak stale telemetry.
 */
const osVitestRetryTelemetryFile = "/tmp/os-preview-vitest-retries.json";
/** Structured timing for the standalone onboarding smoke's logical test. */
const osOnboardingSmokeTelemetryFile = "/tmp/os-preview-onboarding-smoke.json";
/** Same JSON shape, written by the Microsoft TUI Test wrapper. */
const osTuiRetryTelemetryFile = "/tmp/os-preview-tui-retries.json";
/** Same contract for the streams-example-app lane's vitest sub-lane. */
const streamsExampleVitestRetryTelemetryFile =
  "/tmp/os-preview-streams-example-vitest-retries.json";
const docsVitestTelemetryFile = "/tmp/docs-preview-vitest-results.json";
const authVitestTelemetryFile = "/tmp/auth-preview-vitest-results.json";
const semaphoreVitestTelemetryFile = "/tmp/semaphore-preview-vitest-results.json";
const dummyPetshopVitestTelemetryFile = "/tmp/dummy-petshop-preview-vitest-results.json";

/** Reads an immediate preview summary from any runner's canonical artifact. */
async function readCanonicalTestTelemetry(
  filePath: string,
  lane: string,
): Promise<PreviewTestSummary> {
  const parsed = TestTelemetryArtifact.parse(JSON.parse(await readFile(filePath, "utf8")));
  if (parsed.tests.length === 0) throw new Error(`${filePath} contained no test results`);
  return {
    testCount: parsed.tests.length,
    retried: parsed.tests
      .filter((record) => record.retryCount > 0)
      .map((record) => ({
        lane,
        name: record.fullName,
        retryCount: record.retryCount,
        passedAfterRetry: record.passedAfterRetry,
        ...(record.firstFailure ? { firstFailure: record.firstFailure } : {}),
      })),
    collectionErrors: [],
  };
}

/**
 * Reads Playwright's JSON report (written by a config's json reporter — the
 * root playwright.config.ts for the os specs, the app-local config for the
 * streams example app). A retried spec has more than one result attempt;
 * Playwright reports "flaky" for passed-after-retry.
 */
async function readPlaywrightTestTelemetry(
  filePath: string,
  lane: string,
): Promise<PreviewTestSummary> {
  /** The subset of Playwright's JSON-reporter suite tree we walk. */
  type PlaywrightJsonSuite = {
    title?: string;
    suites?: PlaywrightJsonSuite[];
    specs?: {
      title?: string;
      tests?: {
        projectName?: string;
        status?: string;
        results?: {
          retry?: number;
          status?: string;
          error?: unknown;
          errors?: unknown[];
        }[];
      }[];
    }[];
  };
  const report = JSON.parse(await readFile(filePath, "utf8")) as {
    suites?: PlaywrightJsonSuite[];
  };
  let testCount = 0;
  const retried: PreviewRetrySummary["retried"] = [];
  const visit = (suite: PlaywrightJsonSuite, parentTitles: string[] = []) => {
    const titles = suite.title ? [...parentTitles, suite.title] : parentTitles;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        testCount += 1;
        const retryCount = Math.max(0, ...(test.results ?? []).map((result) => result.retry ?? 0));
        const results = test.results ?? [];
        const finalResult = results.at(-1);
        if (retryCount > 0) {
          const firstFailure = results.find((result) => result.status !== "passed");
          const firstFailureSummary = compactRetryFailure(
            firstFailure?.error ?? firstFailure?.errors?.[0],
          );
          retried.push({
            lane,
            name: [...titles, spec.title ?? "(unknown spec)", test.projectName ?? ""]
              .filter(Boolean)
              .join(" › "),
            retryCount,
            passedAfterRetry: test.status === "flaky" || finalResult?.status === "passed",
            ...(firstFailureSummary ? { firstFailure: firstFailureSummary } : {}),
          });
        }
      }
    }
    for (const child of suite.suites ?? []) {
      visit(child, titles);
    }
  };
  for (const suite of report.suites ?? []) {
    visit(suite);
  }
  if (testCount === 0) throw new Error(`${filePath} contained no test results`);
  return { testCount, retried, collectionErrors: [] };
}

/**
 * Reads one sub-lane's telemetry, treating a missing file as "no retries"
 * (the sub-lane may have died before writing) and logging anything else —
 * telemetry must never fail the lane.
 */
async function readTestTelemetryLane(
  label: string,
  read: () => Promise<PreviewTestSummary>,
): Promise<PreviewTestSummary> {
  try {
    return await read();
  } catch (error) {
    const message = `${label}: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`[preview] test telemetry unavailable for ${message}`);
    return { testCount: 0, retried: [], collectionErrors: [message] };
  }
}

function combineTestSummaries(summaries: PreviewTestSummary[]): PreviewTestSummary {
  return {
    testCount: summaries.reduce((total, summary) => total + summary.testCount, 0),
    retried: summaries.flatMap((summary) => summary.retried),
    collectionErrors: summaries.flatMap((summary) => summary.collectionErrors),
  };
}

/** One compact human line for the run log and the PR-body table. */
function renderPreviewRetrySummary(summary: PreviewRetrySummary): string | null {
  if (summary.retried.length === 0) {
    return null;
  }
  const details = summary.retried
    .map(
      (record) =>
        `${record.name} (${record.lane} x${record.retryCount}${record.passedAfterRetry ? "" : ", still failed"})${record.firstFailure ? ` — ${record.firstFailure}` : ""}`,
    )
    .join(" · ");
  return `${summary.retried.length} retried: ${details}`;
}

/**
 * Convert a test command into the single failure stored in preview state.
 * Retries remain visible in telemetry, but the runner's final exit code owns
 * pass/fail: a test that succeeds on its permitted retry is green.
 */
function previewTestFailureMessage(input: {
  result: { exitCode: number | null; stderr?: string; stdout?: string };
  retrySummary: PreviewRetrySummary | null;
}): string | null {
  if (input.result.exitCode !== 0) {
    return commandFailureMessage(input.result, "Preview tests failed after deploy.");
  }

  return null;
}

/**
 * Surfaces retry telemetry without changing the command's outcome. A small
 * number is a notice; a pile-up is a warning because it may indicate a
 * slot-wide incident rather than independent flakes.
 */
function announceRetryTelemetry(slug: string, summary: PreviewRetrySummary) {
  const rendered = renderPreviewRetrySummary(summary);
  if (!rendered) {
    return;
  }
  const retryStillFailed = summary.retried.some((record) => !record.passedAfterRetry);
  const level = retryStillFailed || summary.retried.length >= 4 ? "warning" : "notice";
  const outcome = retryStillFailed
    ? "At least one listed retry still failed; the test command's final exit code remains authoritative for this run."
    : "Every listed retry passed; retry telemetry does not override the test command's final exit code.";
  console.log(
    `::${level} title=Preview e2e retries::${slug}: ${rendered}. ${outcome} ` +
      "Quarantine recurring or pathologically slow unrelated flakes per docs/testing.md.",
  );
}

// Deployed apps compile in @iterate-com/shared via many subpath exports (streams,
// durable-object-utils, callable, codemode, config, evlog, ...), so trigger on the
// whole package rather than chasing individual subdirectories. Deploys are idempotent,
// so over-triggering is safe; under-triggering means prod silently misses deploys.
export const cloudflareAppSharedPaths = [
  "packages/shared/**",
  "packages/ui/**",
  // Dependency manifests: a lockfile bump, a catalog/patchedDependencies entry
  // (pnpm-workspace.yaml), or a pnpm patch can change every app's build
  // output. Selecting "no apps affected" for such a diff leaves the fleet's
  // recorded heads stale at the previous commit, so the test lane then skips
  // every app ("no apps are testable for this head sha") — observed when a
  // patches/-only commit no-op'd the deploy and stranded the PR head.
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "patches/**",
] as const;

export const cloudflarePreviewSharedPaths = [
  // The preview deploy + e2e lifecycle is one Depot CI workflow; cleanup on
  // close lives in cloudflare-preview-cleanup.yml, which mirrors the same
  // paths. Keep this in sync with both files' `on.pull_request.paths` lists:
  // a change to the workflow (or the shared preview orchestration) triggers a
  // full-fleet preview.
  ".depot/workflows/cloudflare-previews.yml",
  ...cloudflareAppSharedPaths,
  "scripts/preview/**",
  "apps/env-manager/**",
  // Every app's generated Wrangler config derives from envs.ts and the
  // Alchemy stack — changing either must redeploy the fleet.
  "envs.ts",
  "scripts/lib/**",
] as const;

/**
 * The complete source closure for Wrangler's OS container applications.
 * Preview may use `--containers-rollout none` only when GitHub proves none of
 * these changed from the exact OS revision already serving on the same slot.
 * Keep this deliberately conservative: an unnecessary rollout costs seconds;
 * a missed input silently leaves stale image or capacity configuration live.
 */
const osContainerRolloutInputPaths = [
  "apps/os/package.json",
  "apps/os/sandbox/**",
  "apps/os/scripts/canonicalize-output-wrangler-config.ts",
  "apps/os/scripts/generate-wrangler-config.ts",
  "apps/os/src/domains/sandboxes/instance-types.ts",
  "apps/os/vite.config.ts",
  "apps/os/wrangler.jsonc",
  "envs.ts",
  "patches/**",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/lib/wrangler-config.ts",
] as const;

/** Trigger preview workflow runs; apps here are not necessarily redeployed. */
export const cloudflarePreviewAdditionalTriggerPaths = ["apps/auth-example/**"] as const;

function requirePreviewEnvironment<T>(
  appSlug: CloudflarePreviewAppSlugType,
  dopplerConfig: string,
  environments: Readonly<Record<string, T>>,
): T {
  const environment = environments[dopplerConfig];
  if (!environment) {
    throw new Error(`Unknown ${appSlug} environment ${JSON.stringify(dopplerConfig)}.`);
  }
  return environment;
}

function previewScriptArtifactSource(
  producer: string,
  lane: string,
  workspace: string,
): TestTelemetryArtifactSource {
  return { producer, framework: "script", testKind: "e2e", lane, workspace };
}

function previewVitestArtifactSource(workspace: string): TestTelemetryArtifactSource {
  return {
    producer: "vitest-retry-telemetry-reporter",
    framework: "vitest",
    testKind: "e2e",
    lane: "vitest",
    workspace,
  };
}

function previewPlaywrightArtifactSource(workspace: string): TestTelemetryArtifactSource {
  return {
    producer: "playwright-telemetry-reporter",
    framework: "playwright",
    testKind: "e2e",
    lane: "playwright",
    workspace,
  };
}

export const cloudflarePreviewApps: Record<CloudflarePreviewAppSlug, CloudflarePreviewApp> = {
  os: {
    slug: "os",
    displayName: "OS",
    appPath: "apps/os",
    deployCommandArgs: ["pnpm", "run-script", "deploy"],
    dopplerProject: "os",
    resolvePreviewAppConfig: (dopplerConfig) => {
      const environment = requirePreviewEnvironment("os", dopplerConfig, envs);
      return {
        baseUrl: environment.baseUrl,
        projectHostnameBases: environment.projectHostnameBases,
        workerName: environment.osWorkerName,
      };
    },
    // oRPC's /api/__internal/health is gone with the teardown — readiness now
    // probes the plain /api/health route that replaced it. Without this, the
    // preview deploy waits the full 10min readiness timeout on a 404 and fails.
    previewReadyUrlPath: "/api/health",
    previewReadyWorkerVersion: true,
    previewTestRolloutGate: "inside-suite",
    paths: [
      "apps/os/**",
      // The root Playwright suite is part of OS preview e2e. A test or
      // harness-only change must produce fresh evidence instead of inheriting
      // the previous head's result.
      "specs/**",
      "playwright.config.ts",
      // The suite also builds and exercises the mobile web app locally.
      "apps/mobile/**",
      // OS imports iterate/sdk, so a CLI/package-only change still needs
      // the OS deployment and its e2e proof.
      "packages/iterate/**",
      "apps/auth/**",
      "apps/auth-contract/**",
      "apps/dummy-petshop/**",
      "apps/os/src/domains/streams/**",
    ],
    // OS binds auth's RPC entrypoint, its root Playwright suite reviews a
    // workspace document through Docs, and its integration e2e uses dummy
    // Petshop. Co-select all three; every deploy starts concurrently and OS
    // derives Auth's public signing key directly from Doppler.
    previewDependencies: ["auth", "docs", "dummy-petshop"],
    // Tests pin wrangler's immutable edge version explicitly.
    previewDeployBudgetMs: 90_000,
    previewTestBudgetMs: 100_000,
    previewTestBaseUrlEnvVar: "APP_CONFIG_BASE_URL",
    previewTestDependencyBaseUrlEnvVars: {
      "dummy-petshop": "PETSHOP_BASE_URL",
    },
    previewTestArtifactSources: [
      previewScriptArtifactSource("onboarding-smoke", "onboarding-smoke", "iterate-root"),
      previewScriptArtifactSource("tui-quarantine", "tui", "iterate-root"),
      previewVitestArtifactSource("@iterate-com/os"),
      previewPlaywrightArtifactSource("iterate-root"),
    ],
    // The apps/os e2e Vitest suite runs its `node` project (engine + itx
    // catalogue matrix; the `browser` project is skipped here — the root
    // Playwright REPL specs cover the catalogue in-browser). It reads
    // APP_CONFIG_BASE_URL from the orchestrator's recorded envs.ts origin and
    // APP_CONFIG_ADMIN_API_SECRET from the leased preview Doppler config.
    // Root Playwright specs run alongside it with the same values.
    previewTestCommandArgs: [
      "bash",
      "-c",
      [
        "set -euo pipefail",
        // Remove stale retry-telemetry files before any lane starts. They survive from a
        // previous run on the same machine (marathon loops), and
        // collectRetryTelemetry runs pass or fail, so a leftover file would
        // report a previous run's retries against this one.
        `rm -f ${osVitestRetryTelemetryFile} ${osTuiRetryTelemetryFile} ${osOnboardingSmokeTelemetryFile} ../../test-results/playwright-results.json`,
        // The chromium download hits no deployed slot, so start it first and
        // let it overlap the smoke and TUI lanes; it's ready by the
        // time we reach the specs instead of adding ~4s in front of them.
        "pnpm --dir ../.. exec playwright install chromium > /tmp/os-preview-pw-install.log 2>&1 & PW_INSTALL_PID=$!",
        // Smoke and TUI own isolated state, so start them with the Chromium
        // install. Playwright starts as soon as Chromium is ready; both its
        // project-creation helpers and the smoke consume the absolute rollout
        // boundary passed above, so unrelated setup continues while fresh
        // project-backed DO work waits. The high-fanout Vitest lane waits for
        // both the production-shaped onboarding smoke and the same bounded age.
        // Edge readiness cannot prove global Durable Object code propagation:
        // Cloudflare may reset an object when its assigned version changes.
        // The age clock starts when deploy completes and overlaps every lane
        // above, so this does not serialize the suite or probe synthetic DOs.
        //
        // The `timeout` on the vitest lane is a WATCHDOG, not a retry
        // (docs/testing.md#retries-and-timeouts): it sits just above a
        // healthy lane (the itx monolith plus the heavy tests' own 240s
        // per-test caps, concurrently) and covers the one hang vitest's own
        // testTimeout can't — a startup wedge before any test runs. Retries
        // live in exactly one layer (the individual test), so a lane killed
        // here fails the run visibly and is re-run from the outer edge. An
        // rc=124 auto-retry used to live here; it fired zero times in ~200
        // Depot runs and was the one place retry layers could stack.
        //
        // Retry telemetry: the TUI and vitest lanes write the same compact
        // JSON shape (stale files were removed at the top of this script) for
        // preview.ts to fold into the PR body alongside Playwright's report.
        'run_logged_lane() { local lane="$1"; local log="$2"; shift 2; local started="$SECONDS"; local rc=0; echo "[preview:os] lane start: $lane"; "$@" > "$log" 2>&1 || rc=$?; echo "[preview:os] lane finish: $lane ($((SECONDS - started))s, exit $rc)"; return "$rc"; }',
        'run_visible_lane() { local lane="$1"; shift; local started="$SECONDS"; local rc=0; echo "[preview:os] lane start: $lane"; "$@" || rc=$?; echo "[preview:os] lane finish: $lane ($((SECONDS - started))s, exit $rc)"; return "$rc"; }',
        `run_visible_lane rollout-settle sleep "$${previewRolloutRemainingSecondsEnvironment}" & ROLLOUT_PID=$!`,
        `run_logged_lane smoke /tmp/os-preview-smoke.log env TEST_TELEMETRY_LANE=onboarding-smoke TEST_TELEMETRY_WORKSPACE=iterate-root TEST_TELEMETRY_ARTIFACT_FILE=${osOnboardingSmokeTelemetryFile} timeout ${OS_ONBOARDING_SMOKE_TIMEOUT_SECS} pnpm exec tsx e2e/vitest/onboarding-smoke.ts & SMOKE_PID=$!`,
        `run_logged_lane tui /tmp/os-preview-tui.log env TEST_TELEMETRY_LANE=tui TEST_TELEMETRY_WORKSPACE=iterate-root TEST_TELEMETRY_ARTIFACT_FILE=${osTuiRetryTelemetryFile} timeout ${OS_TUI_LANE_TIMEOUT_SECS} pnpm exec tsx e2e/tui-test/run.ts & TUI_PID=$!`,
        'PW_INSTALL_OK=0; wait "$PW_INSTALL_PID" || PW_INSTALL_OK=$?',
        `SPEC_OK=0; SPEC_PID=""; if [ "$PW_INSTALL_OK" -eq 0 ]; then run_visible_lane playwright env TEST_TELEMETRY_LANE=playwright TEST_TELEMETRY_WORKSPACE=iterate-root PLAYWRIGHT_PREVIEW_SLOW_FIRST=1 timeout ${OS_PREVIEW_LANE_TIMEOUT_SECS} pnpm --dir ../.. spec & SPEC_PID=$!; else cat /tmp/os-preview-pw-install.log; SPEC_OK=$PW_INSTALL_OK; fi`,
        'SMOKE_OK=0; wait "$SMOKE_PID" || SMOKE_OK=$?',
        'ROLLOUT_OK=0; wait "$ROLLOUT_PID" || ROLLOUT_OK=$?',
        `E2E_OK="$SMOKE_OK"; if [ "$E2E_OK" -eq 0 ]; then E2E_OK="$ROLLOUT_OK"; fi; E2E_PID=""; if [ "$E2E_OK" -eq 0 ]; then run_logged_lane vitest /tmp/os-preview-vitest.log env TEST_TELEMETRY_LANE=vitest TEST_TELEMETRY_WORKSPACE=@iterate-com/os TEST_TELEMETRY_ARTIFACT_FILE=${osVitestRetryTelemetryFile} timeout ${OS_PREVIEW_LANE_TIMEOUT_SECS} pnpm e2e --project node & E2E_PID=$!; fi`,
        'if [ -n "$E2E_PID" ]; then wait "$E2E_PID" || E2E_OK=$?; fi',
        'if [ -n "$SPEC_PID" ]; then wait "$SPEC_PID" || SPEC_OK=$?; fi',
        'TUI_OK=0; wait "$TUI_PID" || TUI_OK=$?',
        "cat /tmp/os-preview-smoke.log",
        "if [ -f /tmp/os-preview-vitest.log ]; then cat /tmp/os-preview-vitest.log; fi",
        "cat /tmp/os-preview-tui.log",
        '[ "$ROLLOUT_OK" -eq 0 ] && [ "$SMOKE_OK" -eq 0 ] && [ "$E2E_OK" -eq 0 ] && [ "$TUI_OK" -eq 0 ] && [ "$SPEC_OK" -eq 0 ]',
      ].join("; "),
    ],
    collectTestTelemetry: async ({ repositoryRoot }) => {
      const [smoke, vitest, specs] = await Promise.all([
        readTestTelemetryLane("os onboarding smoke", () =>
          readCanonicalTestTelemetry(osOnboardingSmokeTelemetryFile, "onboarding smoke"),
        ),
        readTestTelemetryLane("os vitest lane", () =>
          readCanonicalTestTelemetry(osVitestRetryTelemetryFile, "vitest"),
        ),
        readTestTelemetryLane("os playwright specs", () =>
          readPlaywrightTestTelemetry(
            resolve(repositoryRoot, "test-results/playwright-results.json"),
            "playwright",
          ),
        ),
      ]);
      // TUI is currently an explicit no-op skip and produces no test report.
      return combineTestSummaries([smoke, vitest, specs]);
    },
  },
  docs: {
    slug: "docs",
    displayName: "Docs",
    appPath: "apps/docs",
    deployCommandArgs: ["pnpm", "run-script", "deploy"],
    dopplerProject: "docs",
    resolvePreviewAppConfig: (dopplerConfig) => {
      const environment = requirePreviewEnvironment("docs", dopplerConfig, docsEnvs);
      return { baseUrl: environment.baseUrl, workerName: environment.workerName };
    },
    paths: ["apps/docs/**", "packages/workspace-documents/**", "packages/iterate/**"],
    // The vessel reads and writes workspace files through the OS deployment
    // for the same slot. Co-select OS so a Docs preview never reviews a
    // different revision of the workspace API.
    previewDependencies: ["os"],
    previewReadyUrlPath: "/healthz",
    previewReadyWorkerVersion: true,
    previewTestBaseUrlEnvVar: "DOCS_BASE_URL",
    previewTestArtifactSources: [previewVitestArtifactSource("@iterate-com/docs")],
    previewTestCommandArgs: [
      "bash",
      "-c",
      [
        "set -euo pipefail",
        `rm -f ${docsVitestTelemetryFile}`,
        'test "$(curl --fail --silent --show-error "$DOCS_BASE_URL/healthz")" = "ok"',
        'curl --fail --silent --show-error "$DOCS_BASE_URL/" | grep --fixed-strings "Open a workspace document" >/dev/null',
        `TEST_TELEMETRY_KIND=e2e TEST_TELEMETRY_LANE=vitest TEST_TELEMETRY_WORKSPACE=@iterate-com/docs TEST_TELEMETRY_ARTIFACT_FILE=${docsVitestTelemetryFile} pnpm test`,
      ].join("; "),
    ],
    collectTestTelemetry: async () =>
      readTestTelemetryLane("docs vitest lane", () =>
        readCanonicalTestTelemetry(docsVitestTelemetryFile, "vitest"),
      ),
  },
  semaphore: {
    slug: "semaphore",
    displayName: "Semaphore",
    appPath: "apps/semaphore",
    deployCommandArgs: ["pnpm", "run-script", "deploy"],
    // Semaphore's preview e2e generates per-run-unique resource types and
    // self-cleans; there is nothing app-specific to destroy on release.
    dopplerProject: "semaphore",
    resolvePreviewAppConfig: (dopplerConfig) => {
      const environment = requirePreviewEnvironment("semaphore", dopplerConfig, semaphoreEnvs);
      return { baseUrl: environment.baseUrl, workerName: environment.workerName };
    },
    paths: ["apps/semaphore/**"],
    // Co-select auth for an environment-coherent test run. Deploys are independent.
    previewDependencies: ["auth"],
    previewTestRolloutGate: "before-suite",
    previewTestBaseUrlEnvVar: "SEMAPHORE_BASE_URL",
    previewTestArtifactSources: [previewVitestArtifactSource("@iterate-com/semaphore")],
    // `env -u SEMAPHORE_API_TOKEN`: the CI lane runs under an outer
    // `doppler run --project _shared --config prd` whose SEMAPHORE_API_TOKEN
    // targets prd and leaks through into this nested env — never the right
    // credential for a preview slot. Unsetting it makes the e2e forge-mint a
    // slot-scoped admin token instead (scripts/auth/semaphore-token.ts).
    //
    // Full `test:e2e` (both files, sequential, well under a minute), not a
    // preview-only subset: live.e2e.test.ts uniquely covers blocking waitMs
    // acquire, holder + force acquire/release, and least-recently-released
    // handout order — the exact semantics this preview machinery's own slot
    // leasing depends on — and was previously invoked by NOTHING
    // (docs/testing.md#lanes).
    previewTestCommandArgs: [
      "bash",
      "-c",
      `rm -f ${semaphoreVitestTelemetryFile}; env -u SEMAPHORE_API_TOKEN TEST_TELEMETRY_WORKSPACE=@iterate-com/semaphore TEST_TELEMETRY_ARTIFACT_FILE=${semaphoreVitestTelemetryFile} pnpm test:e2e`,
    ],
    collectTestTelemetry: async () =>
      readTestTelemetryLane("semaphore vitest lane", () =>
        readCanonicalTestTelemetry(semaphoreVitestTelemetryFile, "vitest"),
      ),
  },
  // Every preview slot runs its own auth deployment (auth.iterate-preview-N.com)
  // so e2e starts from a completely clean, controlled slate. OAuth client
  // credentials are constants in Doppler (`preview provision-auth-preview-configs`);
  // the auth deploy reseeds them into its database on every run. Auth and its
  // relying parties share one Doppler signing key and can deploy concurrently.
  auth: {
    slug: "auth",
    displayName: "Auth",
    appPath: "apps/auth",
    deployCommandArgs: ["pnpm", "run-script", "deploy"],
    dopplerProject: "auth",
    resolvePreviewAppConfig: (dopplerConfig) => {
      const environment = requirePreviewEnvironment("auth", dopplerConfig, authEnvs);
      return { baseUrl: environment.authBaseUrl, workerName: environment.authWorkerName };
    },
    paths: ["apps/auth/**", "apps/auth-contract/**"],
    // better-auth's liveness endpoint; auth has no /api/__internal/health.
    previewReadyUrlPath: "/api/auth/ok",
    previewTestBaseUrlEnvVar: "AUTH_BASE_URL",
    previewTestArtifactSources: [previewVitestArtifactSource("@iterate-com/auth")],
    // The OAuth2/OIDC provider e2e (apps/auth/e2e): discovery-vs-origin,
    // dynamic registration, authorize → consent → code → token exchange with
    // RFC 8707 resource validation, against the live worker — the lane that
    // would have caught the 2026-07-11 streams.iterate.com stale-registration
    // incident (a bare discovery curl used to be all that ran here). The
    // doppler wrap supplies APP_CONFIG_SERVICE_AUTH_TOKEN for the internal.*
    // seeding procedures; preview auth bakes the fixed test OTP the suite
    // signs in with.
    previewTestCommandArgs: [
      "bash",
      "-c",
      `rm -f ${authVitestTelemetryFile}; TEST_TELEMETRY_WORKSPACE=@iterate-com/auth TEST_TELEMETRY_ARTIFACT_FILE=${authVitestTelemetryFile} pnpm test:e2e`,
    ],
    collectTestTelemetry: async () =>
      readTestTelemetryLane("auth vitest lane", () =>
        readCanonicalTestTelemetry(authVitestTelemetryFile, "vitest"),
      ),
  },
  "streams-example-app": {
    slug: "streams-example-app",
    displayName: "Streams Example App",
    appPath: "apps/streams-example-app",
    deployCommandArgs: ["pnpm", "run-script", "deploy"],
    dopplerProject: "streams-example-app",
    resolvePreviewAppConfig: (dopplerConfig) => {
      const environment = requirePreviewEnvironment(
        "streams-example-app",
        dopplerConfig,
        streamsExampleEnvs,
      );
      return { baseUrl: environment.baseUrl, workerName: environment.workerName };
    },
    paths: ["apps/streams-example-app/**", "apps/os/src/domains/streams/**"],
    previewDependencies: ["auth"],
    previewReadyUrlPath: "/api/__internal/health",
    previewReadyWorkerVersion: true,
    previewTestRolloutGate: "before-suite",
    previewTestBaseUrlEnvVar: "WORKER_URL",
    previewTestArtifactSources: [
      previewVitestArtifactSource("@iterate-com/streams-example-app"),
      previewPlaywrightArtifactSource("@iterate-com/streams-example-app"),
    ],
    // The FULL e2e suite (all vitest e2e + all Playwright browser tests), not
    // a tagged subset: a title-tag filter here once silently reduced CI to 3
    // of ~37 tests while the rest rotted (docs/testing.md#lanes). Two
    // sub-lanes run concurrently, each under its own watchdog `timeout`
    // (fail, never retry — docs/testing.md#retries-and-timeouts); the
    // Playwright config runs 4 parallel workers in CI so the browser suite
    // fits its watchdog.
    previewTestCommandArgs: [
      "bash",
      "-c",
      [
        "set -euo pipefail",
        // Stale telemetry/report files from a previous run on the same
        // machine (marathon loops) must not be reported against this one.
        `rm -f ${streamsExampleVitestRetryTelemetryFile} test-results/playwright-results.json`,
        // Deployed playgrounds are admin-only: the node vitest lane rides a
        // forge-minted admin bearer (e2e/auth.ts); Playwright signs itself in
        // via its global setup.
        'export STREAMS_PLAYGROUND_TOKEN="$(pnpm exec tsx e2e/auth.ts)"',
        "pnpm exec playwright install chromium > /tmp/os-preview-streams-example-pw-install.log 2>&1 & install_pid=$!",
        `TEST_TELEMETRY_WORKSPACE=@iterate-com/streams-example-app TEST_TELEMETRY_ARTIFACT_FILE=${streamsExampleVitestRetryTelemetryFile} timeout ${OS_PREVIEW_LANE_TIMEOUT_SECS} pnpm vitest > /tmp/os-preview-streams-example-vitest.log 2>&1 & vitest_pid=$!`,
        'wait "$install_pid" || { cat /tmp/os-preview-streams-example-pw-install.log; exit 1; }',
        // Capture Playwright's exit without aborting (set -e) so the vitest
        // sub-lane always finishes and its log is replayed.
        `PW_OK=0; TEST_TELEMETRY_WORKSPACE=@iterate-com/streams-example-app timeout ${OS_PREVIEW_LANE_TIMEOUT_SECS} pnpm playwright || PW_OK=$?`,
        'VITEST_OK=0; wait "$vitest_pid" || VITEST_OK=$?',
        "cat /tmp/os-preview-streams-example-vitest.log",
        '[ "$VITEST_OK" -eq 0 ] && [ "$PW_OK" -eq 0 ]',
      ].join("; "),
    ],
    collectTestTelemetry: async ({ repositoryRoot }) => {
      const [vitest, playwright] = await Promise.all([
        readTestTelemetryLane("streams-example-app vitest lane", () =>
          readCanonicalTestTelemetry(streamsExampleVitestRetryTelemetryFile, "vitest"),
        ),
        readTestTelemetryLane("streams-example-app playwright lane", () =>
          readPlaywrightTestTelemetry(
            resolve(
              repositoryRoot,
              "apps/streams-example-app/test-results/playwright-results.json",
            ),
            "playwright",
          ),
        ),
      ]);
      return combineTestSummaries([vitest, playwright]);
    },
  },
  "dummy-petshop": {
    slug: "dummy-petshop",
    displayName: "Dummy Petshop",
    appPath: "apps/dummy-petshop",
    deployCommandArgs: ["pnpm", "run-script", "deploy"],
    // The fixture holds only fake data, so cleanup deliberately leaves its
    // worker and singleton Durable Object in place.
    dopplerProject: "dummy-petshop",
    resolvePreviewAppConfig: (dopplerConfig) => {
      const environment = requirePreviewEnvironment(
        "dummy-petshop",
        dopplerConfig,
        dummyPetshopEnvs,
      );
      return { baseUrl: environment.baseUrl, workerName: environment.workerName };
    },
    paths: ["apps/dummy-petshop/**"],
    // The fixture's content barely ever changes; envs.ts rides along because
    // it decides the generated wrangler routes.
    contentFingerprintPaths: ["apps/dummy-petshop", "envs.ts"],
    previewReadyUrlPath: "/",
    previewTestRolloutGate: "before-suite",
    previewTestBaseUrlEnvVar: "PETSHOP_BASE_URL",
    previewTestArtifactSources: [previewVitestArtifactSource("@iterate-com/dummy-petshop")],
    previewTestCommandArgs: [
      "bash",
      "-c",
      `rm -f ${dummyPetshopVitestTelemetryFile}; TEST_TELEMETRY_WORKSPACE=@iterate-com/dummy-petshop TEST_TELEMETRY_ARTIFACT_FILE=${dummyPetshopVitestTelemetryFile} pnpm test:e2e`,
    ],
    collectTestTelemetry: async () =>
      readTestTelemetryLane("dummy-petshop vitest lane", () =>
        readCanonicalTestTelemetry(dummyPetshopVitestTelemetryFile, "vitest"),
      ),
  },
};

const cloudflarePreviewSectionLabel = "CLOUDFLARE_PREVIEW";
const cloudflarePreviewStateLabel = "CLOUDFLARE_PREVIEW_STATE";
const defaultSemaphoreBaseUrl = "https://semaphore.iterate.com";
const defaultRepositoryFullName = "iterate/iterate";
// A preview slot belongs to its PR for the PR's whole life: every `preview
// deploy` and `preview test` run renews the lease for this long, and closing
// the PR releases it. Expiry is only the safety valve for abandoned PRs — a
// PR that pushes nothing for this long loses its slot (the GC sweep reclaims
// it; see docs/preview-resource-gc.md). While a lease is live, nothing takes
// the slot without a human --force. 3h keeps idle slots (and the Cloudflare
// resources behind them) from costing us for a full day after a PR goes quiet;
// a deploy/e2e cycle is minutes, so an active PR never lapses mid-run.
const defaultPreviewLeaseMs = 3 * 60 * 60 * 1000;
// Routed previews can be healthy before Cloudflare has finished issuing edge
// certificates for newly-created hostnames. Some apps record a separate
// project-subdomain URL; wait on that URL only when it is expected to be
// certificate-covered in the preview environment.
// https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/#full-setup
// https://developers.cloudflare.com/ssl/edge-certificates/additional-options/total-tls/
// Keep this long enough for first issuance of supported hostnames while still
// returning immediately once the health endpoint is reachable.
const defaultPreviewReadyTimeoutMs = 600_000;
const previewReadinessRequestTimeoutMs = 10_000;
const defaultPreviewReadyUrlPath = "/api/__internal/health";
const defaultPreviewDeployConcurrency = 5;
const ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE = "environment-config-lease" as const;
// auth/preview root inherits these from auth/dev when it doesn't already carry
// its own value. All are canonical APP_CONFIG_* names (the AppConfig port,
// #1594); the pre-port legacy flat names are gone from every auth config.
const sharedAuthPreviewSecretsCopiedFromDev = [
  "APP_CONFIG_GOOGLE_CLIENT_ID",
  "APP_CONFIG_GOOGLE_CLIENT_SECRET",
  "APP_CONFIG_EMAIL_SENDER_DOMAIN",
  "APP_CONFIG_SIGNUP_ALLOWLIST",
] as const;

/** A live lease returned by an exact Semaphore acquire or renewal. */
export type EnvironmentConfigLease = {
  dopplerConfig: string;
  leasedUntil: number;
  leaseId: string;
  slug: string;
  type: string;
};

/**
 * The PR body's slot reference. The slug and Doppler config are human-facing;
 * the opaque lease ID is useful only as input to Semaphore's exact-token
 * renewal. Persisting the token does not persist ownership: every command must
 * renew it, and a missing or rejected token is an ownership gap.
 *
 */
export const CloudflarePreviewLeaseReference = z.object({
  dopplerConfig: z.string().trim().min(1),
  leaseId: z.uuid(),
  slug: z.string().trim().min(1),
});
export type CloudflarePreviewLeaseReference = z.infer<typeof CloudflarePreviewLeaseReference>;

function toLeaseReference(lease: EnvironmentConfigLease): CloudflarePreviewLeaseReference {
  return {
    dopplerConfig: lease.dopplerConfig,
    leaseId: lease.leaseId,
    slug: lease.slug,
  };
}

const CloudflarePreviewStatus = z.enum([
  "awaiting-tests",
  "claim-failed",
  "cleanup-failed",
  "deploy-failed",
  "deployed",
  "released",
  "tests-failed",
]);

export const CloudflarePreviewAppEntry = z.object({
  appDisplayName: z.string().trim().min(1),
  appSlug: z.string().trim().min(1),
  status: CloudflarePreviewStatus,
  updatedAt: z.string().trim().min(1),
  /** When the successful app deploy command completed for this exact version. */
  deployedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  headSha: z.string().trim().min(1).nullable().optional(),
  message: z.string().trim().min(1).nullable().optional(),
  publicUrl: z.string().trim().url().nullable().optional(),
  runUrl: z.string().trim().url().nullable().optional(),
  shortSha: z.string().trim().min(1).nullable().optional(),
  cleanupDurationMs: z.number().nonnegative().finite().nullable().optional(),
  deployDurationMs: z.number().nonnegative().finite().nullable().optional(),
  /** Time spent resolving the Doppler-backed public URL and Worker identity. */
  deployConfigDurationMs: z.number().nonnegative().finite().nullable().optional(),
  /** Time spent in the app's build, Cloudflare mutation, and app-level smoke command. */
  deployCommandDurationMs: z.number().nonnegative().finite().nullable().optional(),
  /** Time from a successful deploy command to exact-version readiness. */
  deployReadinessDurationMs: z.number().nonnegative().finite().nullable().optional(),
  /** Time spent proving that a content-identical recorded deployment can be reused. */
  deployReuseProofDurationMs: z.number().nonnegative().finite().nullable().optional(),
  /** Public Worker script and immutable Wrangler version proven by this entry. */
  deployedWorkerName: z.string().trim().min(1).nullable().optional(),
  deployedWorkerVersion: z.uuid().nullable().optional(),
  testDurationMs: z.number().nonnegative().finite().nullable().optional(),
  /** Rendered retry telemetry for the last test run (renderPreviewRetrySummary). */
  testRetries: z.string().trim().min(1).nullable().optional(),
  /** Wrangler-reported "Total Upload" of the deployed worker, in KiB. */
  workerSizeKib: z.number().nonnegative().finite().nullable().optional(),
  /** Wrangler-reported gzip size of the deployed worker, in KiB. */
  workerGzipKib: z.number().nonnegative().finite().nullable().optional(),
  /** Content fingerprint of the deployed sources (contentFingerprintPaths). */
  deployedFingerprint: z.string().trim().min(1).nullable().optional(),
  /**
   * Main's deployed gzip size in KiB at deploy time, read from the
   * `worker-size/<app>` commit status main deploys publish — the baseline for
   * the table's "vs main" delta. Absent until the first post-merge main
   * deploy publishes one.
   */
  mainWorkerGzipKib: z.number().nonnegative().finite().nullable().optional(),
});
export type CloudflarePreviewAppEntry = z.infer<typeof CloudflarePreviewAppEntry>;

const CloudflarePreviewState = z.object({
  apps: z.record(z.string().trim().min(1), CloudflarePreviewAppEntry).default({}),
  // An opaque fencing-token reference, never ownership authority (see
  // CloudflarePreviewLeaseReference).
  environmentConfigLease: CloudflarePreviewLeaseReference.nullable().default(null),
  /**
   * Prominent banner rendered at the top of the managed PR-body section —
   * slot exhaustion, slot takeovers, and moves land here so they are
   * impossible to miss. Cleared by the next successful deploy claim.
   */
  notice: z.string().trim().min(1).nullable().default(null),
});

const CloudflareZonesResponse = z
  .object({
    success: z.boolean(),
    errors: z
      .array(
        z
          .object({
            message: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
    result: z
      .array(
        z
          .object({
            name: z.string(),
            account: z
              .object({
                id: z.string(),
              })
              .passthrough()
              .optional(),
            status: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

type CloudflarePreviewState = z.infer<typeof CloudflarePreviewState>;

type EnvironmentConfigLeaseResourceData = {
  dopplerConfig: string;
};

type EnvironmentConfigLeaseInventoryItem = {
  type: typeof ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE;
  slug: string;
  data: EnvironmentConfigLeaseResourceData;
};

export const environmentConfigLeaseInventory = claimablePreviewEnvironmentSlotNumbers.map(
  (leaseNumber) => {
    return {
      type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
      slug: `preview-${leaseNumber}`,
      data: {
        dopplerConfig: `preview_${leaseNumber}`,
      },
    };
  },
) satisfies EnvironmentConfigLeaseInventoryItem[];

const previewEnvironmentSlugs = environmentConfigLeaseInventory.map((resource) => resource.slug);

function resolveRequestedPreviewEnvironment(body: string): string | null {
  const actionableBody = withoutMarkdownExamplesOrComments(body);
  const matches = [...actionableBody.matchAll(/^preview_environment=(preview-\d+)\r?$/gm)];
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error("PR body must contain at most one preview_environment directive");
  }

  const slug = matches[0]?.[1];
  if (!slug || !previewEnvironmentSlugs.includes(slug)) {
    throw new Error(
      `Unknown preview_environment ${slug || "value"}. Expected one of: ${previewEnvironmentSlugs.join(", ")}`,
    );
  }
  return slug;
}

function withoutMarkdownExamplesOrComments(body: string): string {
  const lines = body.replace(/<!--[\s\S]*?-->/g, "").split("\n");
  const actionable: string[] = [];
  let fence: { length: number; marker: "`" | "~" } | null = null;

  for (const line of lines) {
    const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (match && match[1]?.[0] === fence.marker && match[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (match?.[1]) {
      fence = { length: match[1].length, marker: match[1][0] as "`" | "~" };
      continue;
    }
    actionable.push(line);
  }

  return actionable.join("\n");
}

function describePreviewSlotChange(input: {
  changedAt: string;
  nextSlug: string;
  previousSlug: string | null;
  requestedEnvironment: string | null;
}): string | null {
  if (!input.previousSlug || input.previousSlug === input.nextSlug) return null;
  if (input.requestedEnvironment === input.nextSlug) {
    return `This PR requested ${input.nextSlug} via preview_environment, so its slot changed from ${input.previousSlug} to ${input.nextSlug} at ${input.changedAt}. Everything below refers to the new slot.`;
  }
  return `This PR's slot changed from ${input.previousSlug} to ${input.nextSlug} at ${input.changedAt} (the old lease lapsed and someone else took the slot). Everything below refers to the new slot.`;
}

type PreviewSemaphoreLease = {
  data: Record<string, unknown>;
  expiresAt: number;
  holder?: string | null;
  leaseId: string;
  slug: string;
  type: string;
};

export type PreviewSemaphoreResourceClient = {
  add: (input: { data: Record<string, unknown>; slug: string; type: string }) => Promise<unknown>;
  acquire: (input: {
    allowedSlugs: string[];
    holder?: string;
    leaseMs: number;
    type: string;
    waitMs?: number;
  }) => Promise<PreviewSemaphoreLease>;
  acquireSpecific: (input: {
    allowedSlugs: string[];
    force?: boolean;
    holder?: string;
    leaseMs: number;
    slug: string;
    type: string;
  }) => Promise<PreviewSemaphoreLease | null>;
  renew: (input: {
    leaseId: string;
    leaseMs: number;
    slug: string;
    type: string;
  }) => Promise<PreviewSemaphoreLease | null>;
  release: (input: { force?: boolean; leaseId?: string; slug: string; type: string }) => Promise<{
    released: boolean;
  }>;
  delete: (input: { slug: string; type: string }) => Promise<{ deleted: boolean }>;
  list: (input: { type: string }) => Promise<
    Array<{
      data: Record<string, unknown>;
      holder?: string | null;
      lastAcquiredAt: number | null;
      lastReleasedAt: number | null;
      leaseState: "available" | "leased";
      leasedUntil: number | null;
      slug: string;
    }>
  >;
};

export type PreviewAppRuntime = (typeof cloudflarePreviewApps)[CloudflarePreviewAppSlugType];

type PreviewRuntime = {
  commandEnvironment: NodeJS.ProcessEnv;
  createPreviewSemaphoreResourceClient: () => PreviewSemaphoreResourceClient;
  readEnvironmentState: typeof readEnvironmentState;
  repositoryRoot: string;
  signal?: AbortSignal;
};

type PullRequestPreviewContext = {
  githubToken: string;
  pullRequestBaseSha: string;
  pullRequestBody: string;
  pullRequestHeadSha: string;
  pullRequestHeadRef?: string;
  pullRequestIsDraft: boolean;
  pullRequestLabels: string[];
  pullRequestNumber: number;
  repositoryFullName: string;
  workflowRunUrl: string | null;
};

function resolvePreviewTestTelemetryEnvironment(input: {
  app: string;
  context: PullRequestPreviewContext;
  previewSlot: string;
}): Record<string, string> {
  return {
    TEST_TELEMETRY_KIND: "e2e",
    TEST_TELEMETRY_APP: input.app,
    TEST_TELEMETRY_HEAD_SHA: input.context.pullRequestHeadSha,
    ...(input.context.pullRequestHeadRef
      ? { TEST_TELEMETRY_BRANCH: input.context.pullRequestHeadRef }
      : {}),
    TEST_TELEMETRY_PULL_REQUEST_NUMBER: String(input.context.pullRequestNumber),
    TEST_TELEMETRY_PREVIEW_SLOT: input.previewSlot,
  };
}

type CheckResult = {
  ok: boolean;
  message?: string;
};

type CloudflareCredentialsResult =
  | {
      ok: true;
      accountId: string;
      apiToken: string;
      project: string;
    }
  | {
      ok: false;
      message: string;
      project: string;
    };

type EnvironmentConfigLeaseReconcileIssue = {
  check: "resource-data" | "doppler-config" | "cloudflare-credentials" | "cloudflare-zone";
  message: string;
  resourceSlug: string;
};

const previewManagedDopplerProjects = [
  ...new Set(Object.values(cloudflarePreviewApps).map((app) => app.dopplerProject)),
].sort();

const previewCloudflareCredentialsProject = cloudflarePreviewApps.os.dopplerProject;

function createPreviewRuntime(): PreviewRuntime {
  return {
    commandEnvironment: process.env,
    createPreviewSemaphoreResourceClient: () => createPreviewSemaphoreResourceClient(process.env),
    readEnvironmentState,
    repositoryRoot: process.cwd(),
  };
}

function createPreviewSemaphoreResourceClient(
  env: NodeJS.ProcessEnv,
): PreviewSemaphoreResourceClient {
  // Semaphore is behind the same apps/auth auth as os: authenticate with a
  // pre-minted bearer token (SEMAPHORE_API_TOKEN) when one is provided, else
  // forge-mint an admin access token from the config's forge key
  // (scripts/auth/semaphore-token.ts).
  const semaphore = createSemaphoreClient({
    apiKey: createSemaphoreTokenProvider({
      baseUrl: defaultSemaphoreBaseUrl,
      email: "preview-cli@iterate.com",
      env,
    }),
    baseURL: defaultSemaphoreBaseUrl,
  });

  return {
    add: ({ data, slug, type }) => semaphore.resources.add({ data, slug, type }),
    acquire: ({ allowedSlugs, holder, leaseMs, type, waitMs }) =>
      semaphore.resources.acquire({ allowedSlugs, holder, leaseMs, type, waitMs }),
    acquireSpecific: ({ allowedSlugs, force, holder, leaseMs, slug, type }) =>
      semaphore.resources.acquireSpecific({ allowedSlugs, force, holder, leaseMs, slug, type }),
    renew: ({ leaseId, leaseMs, slug, type }) =>
      semaphore.resources.renew({ leaseId, leaseMs, slug, type }),
    release: ({ force, leaseId, slug, type }) =>
      semaphore.resources.release({ force, leaseId, slug, type }),
    delete: ({ slug, type }) => semaphore.resources.delete({ slug, type }),
    list: ({ type }) => semaphore.resources.list({ type }),
  };
}

type PreviewInventoryClient = {
  add: (input: EnvironmentConfigLeaseInventoryItem) => Promise<unknown>;
  delete: (input: { slug: string; type: string }) => Promise<unknown>;
  list: (input: {
    type: string;
  }) => Promise<Array<{ slug: string; data: Record<string, unknown> }>>;
};

async function syncPreviewInventory(input: {
  client: PreviewInventoryClient;
  inventory?: readonly EnvironmentConfigLeaseInventoryItem[];
}) {
  const inventory = input.inventory || environmentConfigLeaseInventory;
  const expectedBySlug = new Map(inventory.map((resource) => [resource.slug, resource]));
  const existingResources = await input.client.list({
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
  });

  for (const existing of existingResources) {
    const expected = expectedBySlug.get(existing.slug);
    if (expected && isSameResourceData(existing.data, expected.data)) {
      continue;
    }

    await input.client.delete({
      type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
      slug: existing.slug,
    });
  }

  const currentResources = await input.client.list({
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
  });
  const currentSlugs = new Set(currentResources.map((resource) => resource.slug));

  for (const resource of inventory) {
    if (currentSlugs.has(resource.slug)) {
      continue;
    }

    await input.client.add(resource);
  }

  return {
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
    total: inventory.length,
  };
}

function parseEnvironmentConfigLeaseData(
  data: Record<string, unknown>,
): EnvironmentConfigLeaseResourceData {
  if (typeof data.dopplerConfig !== "string" || data.dopplerConfig.trim().length === 0) {
    throw new Error("Environment config lease data must include dopplerConfig.");
  }

  return {
    dopplerConfig: data.dopplerConfig.trim(),
  };
}

function isSameResourceData(
  left: Record<string, unknown>,
  right: EnvironmentConfigLeaseResourceData,
) {
  try {
    const parsed = parseEnvironmentConfigLeaseData(left);
    return parsed.dopplerConfig === right.dopplerConfig && Object.keys(left).length === 1;
  } catch {
    return false;
  }
}

async function readCloudflarePreviewState(params: {
  githubToken: string;
  repositoryFullName: string;
  pullRequestNumber: number;
}) {
  const body = await readPullRequestBody(params);

  return {
    body,
    state: parseCloudflarePreviewState(body),
  };
}

async function updateCloudflarePreviewState(params: {
  githubToken: string;
  repositoryFullName: string;
  pullRequestNumber: number;
  update: (state: CloudflarePreviewState) => CloudflarePreviewState;
}) {
  const current = await readCloudflarePreviewState(params);
  const nextState = CloudflarePreviewState.parse(params.update(current.state));

  await writePullRequestBody({
    ...params,
    body: renderCloudflarePreviewPullRequestBody(current.body, nextState),
  });

  return { state: nextState };
}

function parseCloudflarePreviewState(body: string): CloudflarePreviewState {
  const current = markdownAnnotator(body, cloudflarePreviewStateLabel).current;
  if (!current) {
    return CloudflarePreviewState.parse({});
  }

  try {
    const parsed = JSON.parse(unwrapHiddenStateBlock(current));
    return CloudflarePreviewState.parse(parsed);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return CloudflarePreviewState.parse({});
    }

    throw error;
  }
}

function renderCloudflarePreviewPullRequestBody(body: string, state: CloudflarePreviewState) {
  return markdownAnnotator(body, cloudflarePreviewSectionLabel).update(
    renderCloudflarePreviewSection(CloudflarePreviewState.parse(state)),
  );
}

function renderCloudflarePreviewSection(state: CloudflarePreviewState) {
  const entries = Object.values(state.apps).sort((left, right) =>
    left.appDisplayName.localeCompare(right.appDisplayName),
  );
  const table = entries.length > 0 ? renderPreviewAppTable(entries) : null;
  const failureDetails = entries.map(renderPreviewAppFailureDetails).filter(Boolean).join("\n\n");

  const notice = state.notice
    ? ["> [!CAUTION]", ...state.notice.split("\n").map((line) => `> ${line}`)].join("\n")
    : null;

  return [
    "## Environment Config Lease",
    notice,
    markdownAnnotator("", cloudflarePreviewStateLabel).update(wrapHiddenStateBlock(state)),
    renderPreviewAppTableDetails({
      // Expiry and leaseId are deliberately absent: they live in the
      // semaphore (single source of lease truth) and a rendered copy would
      // only go stale.
      summary: state.environmentConfigLease
        ? `Slot: ${state.environmentConfigLease.slug} | Doppler config: ${state.environmentConfigLease.dopplerConfig}`
        : "No preview slot recorded.",
      table,
    }),
    failureDetails || null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function renderPreviewAppTableDetails(input: { summary: string; table: string | null }) {
  return [
    "<details>",
    `<summary>${escapeHtml(input.summary)}</summary>`,
    "",
    input.table || "No preview apps recorded.",
    "",
    "</details>",
  ].join("\n");
}

function renderPreviewAppTable(entries: z.infer<typeof CloudflarePreviewAppEntry>[]) {
  const headers = [
    "app",
    "status",
    "commit",
    "preview",
    "size (gzip)",
    "deploy duration",
    "test duration",
    "retries",
    "cleanup duration",
    "workflow run",
    "updated",
    "summary",
  ];

  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...entries.map(renderPreviewAppTableRow),
  ].join("\n");
}

function renderPreviewAppTableRow(entry: z.infer<typeof CloudflarePreviewAppEntry>) {
  const summary = summarizePreviewMessage(entry.message);
  const cells = [
    entry.appDisplayName,
    renderStatusLabel(entry.status),
    entry.shortSha ? `\`${entry.shortSha}\`` : "",
    entry.publicUrl ? `[${entry.publicUrl}](${entry.publicUrl})` : "",
    renderWorkerSizeCell(entry.workerGzipKib, entry.mainWorkerGzipKib),
    entry.deployDurationMs != null ? formatDurationMs(entry.deployDurationMs) : "",
    entry.testDurationMs != null ? formatDurationMs(entry.testDurationMs) : "",
    entry.testRetries ?? "",
    entry.cleanupDurationMs != null ? formatDurationMs(entry.cleanupDurationMs) : "",
    entry.runUrl ? `[Workflow run](${entry.runUrl})` : "",
    entry.updatedAt,
    summary || "",
  ];

  return `| ${cells.map((value) => value.replaceAll("\n", "<br>").replaceAll("|", "\\|")).join(" | ")} |`;
}

function renderPreviewAppFailureDetails(entry: z.infer<typeof CloudflarePreviewAppEntry>) {
  const details = readPreviewMessage(entry.message);
  const showFailureDetails = entry.status !== "deployed" && entry.status !== "released" && details;

  if (!showFailureDetails) {
    return null;
  }

  return [
    "<details>",
    `<summary>${escapeHtml(entry.appDisplayName)} failure details</summary>`,
    "",
    `<pre>${escapeHtml(details)}</pre>`,
    "",
    "</details>",
  ].join("\n");
}

function formatDurationMs(durationMs: number) {
  if (durationMs < 1_000) {
    return `${Math.round(durationMs)}ms`;
  }

  return `${(durationMs / 1_000).toFixed(1)}s`;
}

/**
 * Soft performance guardrail: when a phase runs slower than its budget, emit a
 * GitHub/Depot `::warning::` workflow-command annotation so preview CI creep
 * surfaces on the PR without failing the run. No-op when no budget is set or
 * the phase is within budget. See docs/ci-preview-performance.md.
 */
function warnIfOverBudget(
  phase: "deploy" | "e2e",
  slug: string,
  actualMs: number,
  budgetMs: number | undefined,
) {
  if (budgetMs == null || actualMs <= budgetMs) return;
  const over = formatDurationMs(actualMs - budgetMs);
  console.log(
    `::warning title=Preview ${phase} over budget::${slug} ${phase} took ${formatDurationMs(actualMs)}, ` +
      `${over} over the ${formatDurationMs(budgetMs)} budget. If this is the new floor, update ` +
      `preview${phase === "deploy" ? "Deploy" : "Test"}BudgetMs in scripts/preview/preview.ts; ` +
      `otherwise see docs/ci-preview-performance.md before landing.`,
  );
}

function readPreviewMessage(message: string | null | undefined) {
  return message?.trim() || null;
}

function summarizePreviewMessage(message: string | null | undefined) {
  const details = readPreviewMessage(message);
  if (!details) {
    return null;
  }

  const lines = details
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return null;
  }

  const interestingLine =
    lines.find((line) =>
      /(assertionerror|error:|failed|timed out|cannot |malformed|unavailable|released|already gone)/i.test(
        line,
      ),
    ) || lines[0];

  return interestingLine.length <= 180 ? interestingLine : `${interestingLine.slice(0, 179)}...`;
}

function renderStatusLabel(status: z.infer<typeof CloudflarePreviewAppEntry>["status"]) {
  switch (status) {
    case "awaiting-tests":
      return "awaiting tests";
    case "deployed":
      return "deployed";
    case "tests-failed":
      return "tests failed";
    case "deploy-failed":
      return "deploy failed";
    case "claim-failed":
      return "claim failed";
    case "released":
      return "released";
    case "cleanup-failed":
      return "cleanup failed";
  }
}

/** Escape command output before embedding it in the preview status markdown block. */
function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Pair with unwrapHiddenStateBlock: serialize preview state into a hidden markdown comment. */
function wrapHiddenStateBlock(state: CloudflarePreviewState) {
  return ["<!--", JSON.stringify(state, null, 2), "-->"].join("\n");
}

function unwrapHiddenStateBlock(contents: string) {
  const lines = contents.trim().split("\n");
  if (lines[0] === "<!--" && lines.at(-1) === "-->") {
    return lines.slice(1, -1).join("\n");
  }

  return contents;
}

async function readPullRequestBody(params: {
  githubToken: string;
  repositoryFullName: string;
  pullRequestNumber: number;
}) {
  const octokit = new Octokit({
    auth: params.githubToken,
  });
  const [owner, repo] = splitRepositoryFullName(params.repositoryFullName);
  const pullRequest = await withGithubRetry("pulls.get (body)", () =>
    octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: params.pullRequestNumber,
    }),
  );

  return pullRequest.data.body || "";
}

async function writePullRequestBody(params: {
  body: string;
  githubToken: string;
  repositoryFullName: string;
  pullRequestNumber: number;
}) {
  const octokit = new Octokit({
    auth: params.githubToken,
  });
  const [owner, repo] = splitRepositoryFullName(params.repositoryFullName);
  await withGithubRetry("pulls.update", () =>
    octokit.rest.pulls.update({
      body: params.body,
      owner,
      repo,
      pull_number: params.pullRequestNumber,
    }),
  );
}

/**
 * Newest `worker-size/<app>` commit status per preview app on main — the
 * baseline for the PR table's "vs main" size delta, published by the main
 * deploy workflows (scripts/ci/report-worker-size.ts). Apps deploy
 * independently (path-filtered workflows), so no single main commit carries a
 * status for every app: walk recent main commits and take each app's newest.
 */
async function fetchMainWorkerSizeBaselines(params: {
  githubToken: string;
  repositoryFullName: string;
}): Promise<Record<string, WorkerSizeInfo>> {
  const octokit = new Octokit({ auth: params.githubToken });
  const [owner, repo] = splitRepositoryFullName(params.repositoryFullName);
  const commits = await withGithubRetry("repos.listCommits (main)", () =>
    octokit.rest.repos.listCommits({ owner, repo, sha: "main", per_page: 30 }),
  );
  // All-or-nothing: swallowing one commit's failed status read could
  // silently promote an OLDER commit's baseline and render a misleading
  // "vs main" delta — a blank delta beats a wrong one. Any rejection here
  // propagates to the caller's catch, which drops deltas for this run.
  const combinedStatuses = await Promise.all(
    commits.data.map((commit) =>
      octokit.rest.repos
        .getCombinedStatusForRef({ owner, repo, ref: commit.sha })
        .then((response) => ({ sha: commit.sha, statuses: response.data.statuses })),
    ),
  );

  const baselines: Record<string, WorkerSizeInfo> = {};
  // Newest commit first, first hit per app wins.
  for (const { sha, statuses } of combinedStatuses) {
    for (const slug of Object.keys(cloudflarePreviewApps)) {
      if (baselines[slug]) {
        continue;
      }
      const status = statuses.find((entry) => entry.context === workerSizeStatusContext(slug));
      const parsed = parseWorkerSizeStatusDescription(status?.description);
      if (parsed) {
        baselines[slug] = parsed;
        logPreview(
          `worker-size baseline for ${slug}: gzip ${parsed.gzipKib} KiB (main@${sha.slice(0, 7)})`,
        );
      }
    }
  }
  if (Object.keys(baselines).length === 0) {
    logPreview(
      "no worker-size baselines found on recent main commits — size deltas will be blank until a main deploy publishes one",
    );
  }

  return baselines;
}

type EnvironmentConfigLeaseReconcileResult = {
  checkedAt: string;
  ok: boolean;
  semaphoreBaseUrl: string;
  type: typeof ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE;
  resources: Array<{
    dopplerConfig: string | null;
    domains: string[];
    issues: EnvironmentConfigLeaseReconcileIssue[];
    leaseState: "available" | "leased";
    leasedUntil: string | null;
    slug: string;
  }>;
  summary: {
    resourceCount: number;
    issueCount: number;
  };
};

type EnvironmentConfigLeaseResourceRecord = {
  slug: string;
  data: Record<string, unknown>;
  leaseState: "available" | "leased";
  leasedUntil: number | null;
};

async function reconcileEnvironmentConfigLeaseResources(input: {
  checkCloudflareZone?: (input: {
    accountId: string;
    apiToken: string;
    domain: string;
    signal?: AbortSignal;
  }) => Promise<CheckResult>;
  checkDopplerConfig?: (input: {
    commandEnvironment: NodeJS.ProcessEnv;
    config: string;
    project: string;
    repositoryRoot: string;
    signal?: AbortSignal;
  }) => Promise<CheckResult>;
  client: {
    list: (input: { type: string }) => Promise<EnvironmentConfigLeaseResourceRecord[]>;
  };
  commandEnvironment: NodeJS.ProcessEnv;
  readCloudflareCredentials?: (input: {
    commandEnvironment: NodeJS.ProcessEnv;
    config: string;
    project: string;
    repositoryRoot: string;
    signal?: AbortSignal;
  }) => Promise<CloudflareCredentialsResult>;
  repositoryRoot: string;
  semaphoreBaseUrl: string;
  signal?: AbortSignal;
}): Promise<EnvironmentConfigLeaseReconcileResult> {
  const checkDopplerConfig = input.checkDopplerConfig || checkDopplerConfigWithCli;
  const readCloudflareCredentials =
    input.readCloudflareCredentials || readCloudflareCredentialsWithCli;
  const checkCloudflareZone = input.checkCloudflareZone || checkCloudflareZoneWithApi;
  const resources = (
    await input.client.list({
      type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
    })
  ).sort((left, right) => left.slug.localeCompare(right.slug));

  const reconciledResources = [];
  for (const resource of resources) {
    const issues: EnvironmentConfigLeaseReconcileIssue[] = [];
    let dopplerConfig: string | null = null;
    let domains: string[] = [];

    try {
      const data = parseEnvironmentConfigLeaseData(resource.data);
      dopplerConfig = data.dopplerConfig;
      if (Object.keys(resource.data).length !== 1) {
        issues.push({
          check: "resource-data",
          resourceSlug: resource.slug,
          message: "Resource data must contain only dopplerConfig.",
        });
      }
    } catch (error) {
      issues.push({
        check: "resource-data",
        resourceSlug: resource.slug,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    if (dopplerConfig !== null) {
      for (const project of previewManagedDopplerProjects) {
        const configCheck = await checkDopplerConfig({
          commandEnvironment: input.commandEnvironment,
          config: dopplerConfig,
          project,
          repositoryRoot: input.repositoryRoot,
          signal: input.signal,
        });
        if (!configCheck.ok) {
          issues.push({
            check: "doppler-config",
            resourceSlug: resource.slug,
            message: `${project}/${dopplerConfig}: ${configCheck.message || "config check failed"}`,
          });
        }
      }

      const previewNumber = parsePreviewConfigNumber(dopplerConfig);
      if (previewNumber === null) {
        issues.push({
          check: "resource-data",
          resourceSlug: resource.slug,
          message: `Doppler config must match preview_N, got ${dopplerConfig}.`,
        });
      } else {
        domains = [`iterate-preview-${previewNumber}.com`, `iterate-preview-${previewNumber}.app`];
        const credentials = await readCloudflareCredentials({
          commandEnvironment: input.commandEnvironment,
          config: dopplerConfig,
          project: previewCloudflareCredentialsProject,
          repositoryRoot: input.repositoryRoot,
          signal: input.signal,
        });
        if (!credentials.ok) {
          issues.push({
            check: "cloudflare-credentials",
            resourceSlug: resource.slug,
            message: `${credentials.project}/${dopplerConfig}: ${credentials.message}`,
          });
        } else {
          for (const domain of domains) {
            const zoneCheck = await checkCloudflareZone({
              accountId: credentials.accountId,
              apiToken: credentials.apiToken,
              domain,
              signal: input.signal,
            });
            if (!zoneCheck.ok) {
              issues.push({
                check: "cloudflare-zone",
                resourceSlug: resource.slug,
                message: `${domain}: ${zoneCheck.message || "zone check failed"}`,
              });
            }
          }
        }
      }
    }

    reconciledResources.push({
      dopplerConfig,
      domains,
      issues,
      leaseState: resource.leaseState,
      leasedUntil:
        resource.leasedUntil === null ? null : new Date(resource.leasedUntil).toISOString(),
      slug: resource.slug,
    });
  }

  const issueCount = reconciledResources.reduce(
    (total, resource) => total + resource.issues.length,
    0,
  );

  return {
    checkedAt: new Date().toISOString(),
    ok: issueCount === 0,
    semaphoreBaseUrl: input.semaphoreBaseUrl,
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
    resources: reconciledResources,
    summary: {
      resourceCount: resources.length,
      issueCount,
    },
  };
}

function parsePreviewConfigNumber(config: string) {
  const match = /^preview_(\d+)$/.exec(config);
  if (!match || match[1] == null) return null;
  return Number.parseInt(match[1], 10);
}

async function checkDopplerConfigWithCli(input: {
  commandEnvironment: NodeJS.ProcessEnv;
  config: string;
  project: string;
  repositoryRoot: string;
  signal?: AbortSignal;
}): Promise<CheckResult> {
  try {
    const result = await runCommand({
      command: "doppler",
      args: ["configs", "get", input.config, "--project", input.project, "--json"],
      echoOutput: false,
      environment: input.commandEnvironment,
      signal: input.signal,
      workingDirectory: input.repositoryRoot,
    });
    return result.exitCode === 0
      ? { ok: true }
      : { ok: false, message: commandFailureSummary(result) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function readCloudflareCredentialsWithCli(input: {
  commandEnvironment: NodeJS.ProcessEnv;
  config: string;
  project: string;
  repositoryRoot: string;
  signal?: AbortSignal;
}): Promise<CloudflareCredentialsResult> {
  try {
    const result = await runCommand({
      command: "doppler",
      args: [
        "secrets",
        "download",
        "--no-file",
        "--format",
        "json",
        "--project",
        input.project,
        "--config",
        input.config,
      ],
      echoOutput: false,
      environment: input.commandEnvironment,
      signal: input.signal,
      workingDirectory: input.repositoryRoot,
    });
    if (result.exitCode !== 0) {
      return {
        ok: false,
        project: input.project,
        message: commandFailureSummary(result),
      };
    }

    const secrets = z
      .object({
        CLOUDFLARE_ACCOUNT_ID: z.string().trim().min(1),
        CLOUDFLARE_API_TOKEN: z.string().trim().min(1),
      })
      .passthrough()
      .parse(JSON.parse(result.stdout));

    return {
      ok: true,
      project: input.project,
      accountId: secrets.CLOUDFLARE_ACCOUNT_ID,
      apiToken: secrets.CLOUDFLARE_API_TOKEN,
    };
  } catch (error) {
    return {
      ok: false,
      project: input.project,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkCloudflareZoneWithApi(input: {
  accountId: string;
  apiToken: string;
  domain: string;
  signal?: AbortSignal;
}): Promise<CheckResult> {
  const url = new URL("https://api.cloudflare.com/client/v4/zones");
  url.searchParams.set("name", input.domain);
  url.searchParams.set("per_page", "50");
  const response = await fetchCloudflareWith429Retry(
    `GET ${url.pathname}`,
    () =>
      fetch(url, {
        headers: {
          authorization: `Bearer ${input.apiToken}`,
        },
        signal: input.signal,
      }),
    { signal: input.signal },
  );
  const parsed = CloudflareZonesResponse.parse(await response.json());
  if (!response.ok || !parsed.success) {
    return {
      ok: false,
      message:
        parsed.errors
          .map((error) => error.message)
          .filter(Boolean)
          .join("; ") || `${response.status} ${response.statusText}`,
    };
  }

  return evaluateCloudflareZoneCheck({
    accountId: input.accountId,
    domain: input.domain,
    zones: parsed.result,
  });
}

function evaluateCloudflareZoneCheck(input: {
  accountId: string;
  domain: string;
  zones: Array<{
    account?: { id?: string };
    name: string;
    status?: string;
  }>;
}): CheckResult {
  const matchingZones = input.zones.filter((zone) => zone.name === input.domain);
  const matchingActiveZone = matchingZones.find((zone) => zone.status === "active");
  const matchingAccountZone = matchingZones.find((zone) => zone.account?.id === input.accountId);
  if (matchingActiveZone?.account?.id === input.accountId) {
    return { ok: true };
  }

  if (matchingActiveZone) {
    return {
      ok: false,
      message: `active zone belongs to Cloudflare account ${matchingActiveZone.account?.id || "unknown"}, expected ${input.accountId}`,
    };
  }

  if (matchingAccountZone) {
    return {
      ok: false,
      message: `zone in Cloudflare account ${input.accountId} is ${matchingAccountZone.status || "not active"}`,
    };
  }

  if (matchingZones.length === 0) {
    return {
      ok: false,
      message: `zone not found in Cloudflare account ${input.accountId}`,
    };
  }

  return {
    ok: false,
    message: `zone exists but not in Cloudflare account ${input.accountId}`,
  };
}

function commandFailureSummary(result: { stderr: string; stdout: string }) {
  const output = `${result.stderr}\n${result.stdout}`
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join("\n");
  return output || "command failed";
}

// Prefer an existing preview-root value; otherwise seed it from auth/dev.
function resolveAuthPreviewRootSecret(input: {
  appConfigName: string;
  readSecret: (project: string, config: string, name: string) => string | null;
}) {
  return (
    input.readSecret("auth", "preview", input.appConfigName) ||
    input.readSecret("auth", "dev", input.appConfigName)
  );
}

function resolveSharedPreviewRootSecret(input: {
  authDevSecret: string | null;
  osDevSecret: string | null;
  sharedPreviewSecret: string | null;
}) {
  if (!input.authDevSecret || !input.osDevSecret) {
    throw new Error("auth/dev and os/dev must both define the project-app session secret");
  }
  if (input.authDevSecret !== input.osDevSecret) {
    throw new Error("Auth and OS dev project-app session secrets differ");
  }
  if (input.sharedPreviewSecret && input.sharedPreviewSecret !== input.authDevSecret) {
    throw new Error("The shared preview project-app session secret differs from dev");
  }
  return input.authDevSecret;
}

function previewProvisionedIntegrationSecrets() {
  return {
    APP_CONFIG_INTEGRATIONS__PETSHOP: JSON.stringify({
      oauthClientId: "petshop-default",
      oauthClientSecret: "petshop-default-secret",
    }),
  };
}

async function ensureAuthPreviewConfigs(input: { rotate: boolean; slots: number[] }) {
  const authSigningPrivateJwk = getDopplerSecret(
    "_shared",
    "preview",
    "AUTH_FORGE_ES256_PRIVATE_JWK",
  );
  if (!authSigningPrivateJwk) {
    throw new Error("_shared/preview is missing AUTH_FORGE_ES256_PRIVATE_JWK");
  }

  // This is deliberately inherited, not copied: every app's preview
  // environment root inherits _shared/preview, giving key rotation one source
  // of truth. Fail closed if that topology has drifted instead of writing a
  // second app-local copy that could later shadow the shared key.
  for (const project of ["auth", "os", "semaphore", "streams-example-app"]) {
    const effectiveKey = getDopplerSecret(project, "preview", "AUTH_FORGE_ES256_PRIVATE_JWK");
    if (effectiveKey !== authSigningPrivateJwk) {
      throw new Error(
        `${project}/preview must inherit AUTH_FORGE_ES256_PRIVATE_JWK from _shared/preview`,
      );
    }
  }

  const rootValues: Record<string, string> = {
    APP_CONFIG_EMAIL_OTP_ENABLED: "true",
  };
  for (const appConfigName of sharedAuthPreviewSecretsCopiedFromDev) {
    const value = resolveAuthPreviewRootSecret({ appConfigName, readSecret: getDopplerSecret });
    if (!value) {
      throw new Error(`auth/dev is missing ${appConfigName}`);
    }
    rootValues[appConfigName] = value;
  }
  const projectAppSessionSecret = resolveSharedPreviewRootSecret({
    authDevSecret: getDopplerSecret("auth", "dev", "APP_CONFIG_PROJECT_APP_SESSION_SECRET"),
    osDevSecret: getDopplerSecret("os", "dev", "APP_CONFIG_PROJECT_APP_SESSION_SECRET"),
    sharedPreviewSecret: getDopplerSecret(
      "_shared",
      "preview",
      "APP_CONFIG_PROJECT_APP_SESSION_SECRET",
    ),
  });
  setDopplerSecrets("auth", "preview", rootValues);
  setDopplerSecrets("_shared", "preview", {
    APP_CONFIG_PROJECT_APP_SESSION_SECRET: projectAppSessionSecret,
  });
  console.log("auth/preview and _shared/preview root configs ensured");

  for (const slot of input.slots) {
    const config = `preview_${slot}`;
    const authOrigin = `https://auth.iterate-preview-${slot}.com`;
    const osOrigin = `https://os.iterate-preview-${slot}.com`;
    const semaphoreOrigin = `https://semaphore.iterate-preview-${slot}.com`;
    // Keep in lockstep with streamsExampleEnvs in envs.ts (custom domain —
    // workers.dev is off for this app).
    const streamsExampleOrigin = `https://streams.iterate-preview-${slot}.com`;
    const clientId = `os-preview-${slot}`;
    const semaphoreClientId = `semaphore-preview-${slot}`;
    const streamsExampleClientId = `streams-example-app-preview-${slot}`;

    ensureDopplerConfig("auth", config, "preview");
    ensureDopplerConfig("semaphore", config, "preview");
    ensureDopplerConfig("streams-example-app", config, "preview");

    for (const project of ["auth", "os"]) {
      if (
        getDopplerSecret(project, config, "APP_CONFIG_PROJECT_APP_SESSION_SECRET") !==
        projectAppSessionSecret
      ) {
        throw new Error(
          `${project}/${config} must inherit APP_CONFIG_PROJECT_APP_SESSION_SECRET from _shared/preview; remove the child override`,
        );
      }
    }

    const existingSeed = input.rotate
      ? null
      : getDopplerSecret("auth", config, "AUTH_SEED_OAUTH_CLIENTS");
    const parsedSeed = existingSeed
      ? (JSON.parse(existingSeed) as { clientId: string; clientSecret: string }[])
      : [];
    const clientSecret =
      parsedSeed.find((client) => client.clientId === clientId)?.clientSecret || freshSecret();
    const semaphoreClientSecret =
      parsedSeed.find((client) => client.clientId === semaphoreClientId)?.clientSecret ||
      freshSecret();
    const streamsExampleClientSecret =
      parsedSeed.find((client) => client.clientId === streamsExampleClientId)?.clientSecret ||
      freshSecret();

    const existingServiceToken = input.rotate
      ? null
      : getDopplerSecret("auth", config, "APP_CONFIG_SERVICE_AUTH_TOKEN");
    const serviceToken = existingServiceToken || freshSecret();
    const existingBetterAuthSecret = input.rotate
      ? null
      : getDopplerSecret("auth", config, "APP_CONFIG_BETTER_AUTH_SECRET");
    const betterAuthSecret = existingBetterAuthSecret || freshSecret();
    const seed = JSON.stringify([
      {
        clientId,
        clientSecret,
        clientName: `OS preview ${slot} web`,
        redirectURIs: [`${osOrigin}/api/iterate-auth/callback`],
        referenceId: `os:${config}:web`,
        skipConsent: true,
      },
      {
        clientId: semaphoreClientId,
        clientSecret: semaphoreClientSecret,
        clientName: `Semaphore preview ${slot} web`,
        redirectURIs: [`${semaphoreOrigin}/api/iterate-auth/callback`],
        referenceId: `semaphore:${config}:web`,
        skipConsent: true,
      },
      {
        clientId: streamsExampleClientId,
        clientSecret: streamsExampleClientSecret,
        clientName: `Streams playground preview ${slot} web`,
        redirectURIs: [`${streamsExampleOrigin}/api/iterate-auth/callback`],
        referenceId: `streams-example-app:${config}:web`,
        skipConsent: true,
      },
    ]);

    setDopplerSecrets("auth", config, {
      // Runtime consumers still receive their public origin through Doppler;
      // deployment orchestration derives the same value from root envs.ts.
      APP_CONFIG_BASE_URL: authOrigin,
      AUTH_SEED_OAUTH_CLIENTS: seed,
      APP_CONFIG_AUTH_APP_ORIGIN: authOrigin,
      APP_CONFIG_BETTER_AUTH_SECRET: betterAuthSecret,
      APP_CONFIG_SERVICE_AUTH_TOKEN: serviceToken,
    });

    setDopplerSecrets("os", config, {
      ...previewProvisionedIntegrationSecrets(),
      APP_CONFIG_ITERATE_AUTH__ISSUER: `${authOrigin}/api/auth`,
      APP_CONFIG_ITERATE_AUTH__CLIENT_ID: clientId,
      APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET: clientSecret,
    });

    setDopplerSecrets("semaphore", config, {
      APP_CONFIG_ITERATE_AUTH__CLIENT_ID: semaphoreClientId,
      APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET: semaphoreClientSecret,
    });

    setDopplerSecrets("streams-example-app", config, {
      APP_CONFIG_BASE_URL: streamsExampleOrigin,
      APP_CONFIG_ITERATE_AUTH__CLIENT_ID: streamsExampleClientId,
      APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET: streamsExampleClientSecret,
    });

    console.log(
      `slot ${slot}: auth/${config} + os/${config} + semaphore/${config} + streams-example-app/${config} ensured (clients ${clientId}, ${semaphoreClientId}, ${streamsExampleClientId})`,
    );
  }

  console.log("done");
}

function runDoppler(args: string[], input?: string) {
  return execFileSync("doppler", args, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function getDopplerSecret(project: string, config: string, name: string): string | null {
  try {
    return runDoppler([
      "secrets",
      "get",
      name,
      "--project",
      project,
      "--config",
      config,
      "--plain",
    ]);
  } catch {
    return null;
  }
}

function setDopplerSecrets(project: string, config: string, secrets: Record<string, string>) {
  const args = ["secrets", "set", "--project", project, "--config", config, "--silent"];
  for (const [key, value] of Object.entries(secrets)) {
    args.push(`${key}=${value}`);
  }
  runDoppler(args);
}

function ensureDopplerConfig(project: string, config: string, environment: string) {
  const existing = runDoppler(["configs", "--project", project, "--json"]);
  const configs = JSON.parse(existing) as { environment: string; name: string }[];
  const current = configs.find((dopplerConfig) => dopplerConfig.name === config);
  if (!current) {
    runDoppler(["configs", "create", config, "--project", project, "--environment", environment]);
    console.log(`created config ${project}/${config}`);
  } else if (current.environment !== environment) {
    throw new Error(
      `${project}/${config} belongs to ${current.environment}, expected ${environment}`,
    );
  }
}

function freshSecret() {
  return randomBytes(32).toString("hex");
}

function tryReadGhAuthToken() {
  try {
    return (
      execFileSync("gh", ["auth", "token"], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

function resolveGithubToken(options: PullRequestCommandOptions, env: NodeJS.ProcessEnv): string {
  return requireValue(
    options.githubToken || env.GITHUB_TOKEN?.trim() || tryReadGhAuthToken(),
    "GITHUB_TOKEN is required (or authenticate the gh CLI).",
  );
}

function resolvePullRequestNumber(
  options: PullRequestCommandOptions,
  env: NodeJS.ProcessEnv,
): number {
  const value = options.pullRequestNumber || Number(env.GITHUB_PR_NUMBER);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("A pull request number is required.");
  }

  return value;
}

function normalizePreviewSlotSlug(slot: string) {
  const trimmed = slot.trim().toLowerCase().replaceAll("_", "-");
  return /^\d+$/.test(trimmed) ? `preview-${trimmed}` : trimmed;
}

function splitRepositoryFullName(repositoryFullName: string) {
  const parts = repositoryFullName.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Expected repository full name to look like owner/repo. Got: ${repositoryFullName}`,
    );
  }

  return parts as [string, string];
}

async function cleanupPreviewForPullRequest(
  params: PreviewRuntime & { context: PullRequestPreviewContext },
) {
  logPreview(
    `cleanup for PR #${params.context.pullRequestNumber} — holder ${pullRequestHolder(params.context.pullRequestNumber)}, semaphore ${defaultSemaphoreBaseUrl}`,
  );
  const current = await readCloudflarePreviewState({
    githubToken: params.context.githubToken,
    repositoryFullName: params.context.repositoryFullName,
    pullRequestNumber: params.context.pullRequestNumber,
  });
  // Never destroy a slot this PR does not hold. The PR body supplies an opaque
  // lease ID, but only Semaphore's exact-token renewal proves uninterrupted
  // ownership.
  const holder = pullRequestHolder(params.context.pullRequestNumber);
  const semaphore = params.createPreviewSemaphoreResourceClient();
  const displaySlot = current.state.environmentConfigLease;
  let environmentConfigLease = await renewRecordedEnvironmentConfigLease({
    holder,
    leaseMs: defaultPreviewLeaseMs,
    recordedLease: displaySlot,
    semaphore,
  });
  if (!environmentConfigLease && displaySlot) {
    // A lapsed recorded slot may be taken non-force only to destroy it. The
    // ownership gap means its deployment is never trusted for reuse.
    const retaken = await semaphore.acquireSpecific({
      allowedSlugs: previewEnvironmentSlugs,
      type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
      slug: displaySlot.slug,
      leaseMs: defaultPreviewLeaseMs,
      holder,
    });
    environmentConfigLease = retaken ? toEnvironmentConfigLease(retaken) : null;
  }
  if (!environmentConfigLease) {
    if (!displaySlot) {
      logPreview(`the semaphore leases no slot to ${holder} — nothing to tear down or release`);
      return {
        ok: true,
        released: false,
        teardownFailed: false,
        state: current.state,
      };
    }

    // The recorded slot belongs to someone else now: their deployment lives
    // there, so there is nothing of ours left to destroy.
    const message = `Teardown skipped: ${describeLostSlotOwnership({
      currentHolder: await findEnvironmentConfigLeaseHolder(semaphore, displaySlot.slug),
      displaySlot,
      holder,
    })}`;
    logPreview(`cleanup skipped: ${message}`);
    const update = await updatePreviewState(params.context, (state) => ({
      ...state,
      environmentConfigLease: null,
      notice: message,
      apps: Object.fromEntries(
        Object.entries(state.apps).map(([appSlug, entry]) => [
          appSlug,
          {
            ...entry,
            status: "released" as const,
            message,
            updatedAt: new Date().toISOString(),
          },
        ]),
      ),
    }));
    return {
      ok: true,
      released: false,
      skippedTeardown: true,
      teardownFailed: false,
      state: update.state,
    };
  }

  const cleanupStartedAt = Date.now();
  let cleanupFailure: unknown;
  let teardownOk = true;
  try {
    await destroyEnvironmentUnderLease({
      destroyEnvironment: makePreviewEnvironmentDestroyer(params),
      dopplerConfig: environmentConfigLease.dopplerConfig,
      lease: environmentConfigLease,
      leaseMs: defaultPreviewLeaseMs,
      semaphore,
      signal: params.signal,
    });
  } catch (error) {
    cleanupFailure = error;
    teardownOk = false;
  }
  const cleanupDurationMs = Date.now() - cleanupStartedAt;
  const updateAfterCleanup = await updatePreviewState(params.context, (state) => ({
    ...state,
    apps: Object.fromEntries(
      Object.entries(state.apps).map(([appSlug, entry]) => [
        appSlug,
        {
          ...entry,
          message: teardownOk
            ? "Preview environment released."
            : `Preview teardown failed: ${formatPreviewErrorMessage(cleanupFailure)}`,
          cleanupDurationMs,
          status: teardownOk ? "released" : "cleanup-failed",
          updatedAt: new Date().toISOString(),
        },
      ]),
    ),
  }));
  const latestState = updateAfterCleanup.state;
  console.error(
    `[preview] environment cleanup ${teardownOk ? "passed" : "failed"}: ${environmentConfigLease.slug} (${formatDurationMs(cleanupDurationMs)})`,
  );

  // Cleanup releases even after teardown failure so the fleet does not starve.
  // Environment-manager lifecycle state remains the durable cleanup
  // obligation, so hourly GC can retry without keeping this lease occupied.
  // A lease that is never released leaks until expiry and constrains the fleet
  // (2026-07-14: a Cloudflare API 429 failed cleanup for the
  // merged pr-1950; the old code bailed before releasing and pr-1988 waited
  // 360s for a slot that never came). So: always release; `ok: false` now
  // means the RELEASE itself failed — the lease truly leaked.
  const releaseResult = await releaseLeaseDespiteTeardownFailure({
    lease: environmentConfigLease,
    semaphore,
    teardownOk,
  });
  if (!releaseResult.ok) {
    // Keep the recorded lease in the PR body so a cleanup re-run still finds
    // the slot to release.
    return {
      ok: false,
      released: false,
      teardownFailed: !teardownOk,
      state: latestState,
    };
  }
  const update = await updatePreviewState(params.context, (state) => ({
    ...state,
    environmentConfigLease: null,
    notice: teardownOk
      ? state.notice
      : `Teardown failed but the lease was released; environment-manager retains ${environmentConfigLease.slug}'s failed cleanup state for hourly GC, and its next acquire destroys it before use. (preview cleanup at ${new Date().toISOString()})`,
  }));

  return {
    ok: true,
    released: releaseResult.released,
    teardownFailed: !teardownOk,
    state: update.state,
  };
}

/**
 * Release cleanup's lease whether or not teardown succeeded, loudly flagging
 * the failed-destroy case. Returns `ok: false` only when the release call itself
 * failed or returns false — those mean exact ownership was lost. A teardown
 * failure remains visible in environment-manager and the next acquire also
 * destroys the environment on entry.
 */
async function releaseLeaseDespiteTeardownFailure(input: {
  lease: { type: string; slug: string; leaseId: string };
  semaphore: PreviewSemaphoreResourceClient;
  teardownOk: boolean;
}): Promise<{ ok: boolean; released: boolean }> {
  if (!input.teardownOk) {
    logPreview(
      `teardown FAILED on ${input.lease.slug} — releasing the lease; environment-manager retains the cleanup failure for hourly GC`,
    );
  }
  try {
    const released = await input.semaphore.release({
      type: input.lease.type,
      slug: input.lease.slug,
      leaseId: input.lease.leaseId,
    });
    if (!released.released) {
      logPreview(
        `FAILED to release ${input.lease.slug}: exact lease ownership was lost before release`,
      );
      return { ok: false, released: false };
    }
    logPreview(`lease released: ${input.lease.slug} is free again`);
    return { ok: true, released: true };
  } catch (error) {
    logPreview(
      `FAILED to release the lease on ${input.lease.slug} — it leaks until expiry (free it with \`pnpm preview release --slot ${input.lease.slug} --force\` or re-run cleanup): ${error instanceof Error ? error.message : String(error)}`,
    );
    return { ok: false, released: false };
  }
}

/** Git object ids of the app's fingerprint paths at HEAD — content-addressed,
 * so an unchanged fixture app can skip its deploy entirely. */
function previewAppContentFingerprint(
  app: PreviewAppRuntime,
  repositoryRoot: string,
): string | null {
  if (!app.contentFingerprintPaths?.length) return null;
  return execFileSync(
    "git",
    ["rev-parse", ...app.contentFingerprintPaths.map((path) => `HEAD:${path}`)],
    { cwd: repositoryRoot, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .join("+");
}

async function deployPreviewAppWithStatus(input: {
  app: PreviewAppRuntime;
  commandEnvironment: NodeJS.ProcessEnv;
  dopplerConfig: string;
  /** This app's entry from the PR's recorded state, for the unchanged-skip. */
  existingEntry: CloudflarePreviewAppEntry | null;
  /** Main's published size baseline for this app, when one exists. */
  mainWorkerSize: WorkerSizeInfo | null;
  pullRequestHeadSha: string;
  repositoryRoot: string;
  runUrl: string | null;
  signal?: AbortSignal;
}) {
  const startedAt = Date.now();
  logPreview(
    `deploy start: ${input.app.slug} (${input.app.appPath} with doppler config ${input.dopplerConfig})`,
  );
  try {
    const entry = await deployPreviewApp(input);
    const deployDurationMs = Date.now() - startedAt;
    logPreview(
      `deploy ${entry.status === "awaiting-tests" ? "passed" : "failed"}: ${input.app.slug} (${formatDurationMs(deployDurationMs)})${entry.publicUrl ? ` — ${entry.publicUrl}` : ""}`,
    );
    if (entry.status === "awaiting-tests") {
      warnIfOverBudget("deploy", input.app.slug, deployDurationMs, input.app.previewDeployBudgetMs);
    }
    return CloudflarePreviewAppEntry.parse({
      ...entry,
      deployDurationMs,
    });
  } catch (error) {
    const deployDurationMs = Date.now() - startedAt;
    logPreview(
      `deploy failed: ${input.app.slug} (${formatDurationMs(deployDurationMs)}) — ${formatPreviewErrorMessage(error)}`,
    );
    return CloudflarePreviewAppEntry.parse({
      appDisplayName: input.app.displayName,
      appSlug: input.app.slug,
      deployDurationMs,
      headSha: input.pullRequestHeadSha,
      message: formatPreviewErrorMessage(error),
      runUrl: input.runUrl,
      shortSha: input.pullRequestHeadSha.slice(0, 7),
      status: "deploy-failed",
      updatedAt: new Date().toISOString(),
    });
  }
}

async function deployPreviewApp(input: {
  app: PreviewAppRuntime;
  commandEnvironment: NodeJS.ProcessEnv;
  dopplerConfig: string;
  existingEntry: CloudflarePreviewAppEntry | null;
  mainWorkerSize: WorkerSizeInfo | null;
  pullRequestHeadSha: string;
  repositoryRoot: string;
  runUrl: string | null;
  signal?: AbortSignal;
}) {
  const configStartedAt = Date.now();
  const appConfig = await readPreviewAppConfig({
    app: input.app,
    dopplerConfig: input.dopplerConfig,
  });
  const deployConfigDurationMs = Date.now() - configStartedAt;
  const baseEntry = {
    appDisplayName: input.app.displayName,
    appSlug: input.app.slug,
    deployConfigDurationMs,
    headSha: input.pullRequestHeadSha,
    publicUrl: appConfig.baseUrl,
    runUrl: input.runUrl,
    shortSha: input.pullRequestHeadSha.slice(0, 7),
    updatedAt: new Date().toISOString(),
  } as const;

  const fingerprint = previewAppContentFingerprint(input.app, input.repositoryRoot);
  const existingEntry = input.existingEntry;
  let deployReuseProofDurationMs: number | undefined;
  if (
    fingerprint !== null &&
    existingEntry?.status === "deployed" &&
    existingEntry.publicUrl === appConfig.baseUrl &&
    existingEntry.deployedFingerprint === fingerprint &&
    existingEntry.deployedWorkerName === appConfig.workerName &&
    existingEntry.deployedWorkerVersion
  ) {
    // The record alone is not proof the worker still answers — this app may
    // be selected precisely because the not-serving sweep found it dead
    // (selectRecordedGreenAppsNotServing), e.g. after a stack destroy. Skip only
    // when every readiness URL answers right now.
    const reuseProofStartedAt = Date.now();
    const reuseProofPassed = (
      await Promise.all(
        resolvePreviewReadinessUrls({
          publicUrl: appConfig.baseUrl,
          readyUrlPath: input.app.previewReadyUrlPath,
        }).map((url) => probePreviewAppServingOnce(url)),
      )
    ).every((probe) => probe.ok);
    deployReuseProofDurationMs = Date.now() - reuseProofStartedAt;
    if (reuseProofPassed) {
      // Same slot, same content, last run fully green, worker answering: what
      // is serving is byte-identical to what this deploy would upload. Skip
      // the wrangler/Cloudflare-API round trip; the e2e smoke still verifies it.
      logPreview(
        `deploy skipped: ${input.app.slug} unchanged since ${existingEntry.shortSha ?? "the recorded deploy"} on this slot and serving (fingerprint ${fingerprint.slice(0, 12)}…)`,
      );
      return CloudflarePreviewAppEntry.parse({
        ...baseEntry,
        deployedAt: existingEntry.deployedAt,
        deployedFingerprint: fingerprint,
        deployedWorkerName: existingEntry.deployedWorkerName,
        deployedWorkerVersion: existingEntry.deployedWorkerVersion,
        deployReuseProofDurationMs,
        workerSizeKib: existingEntry.workerSizeKib ?? null,
        workerGzipKib: existingEntry.workerGzipKib ?? null,
        mainWorkerGzipKib: existingEntry.mainWorkerGzipKib ?? null,
        status: "awaiting-tests",
      });
    }
  }

  const commandStartedAt = Date.now();
  const deployResult = await runPreviewDeployCommand({
    app: input.app,
    commandEnvironment: input.commandEnvironment,
    dopplerConfig: input.dopplerConfig,
    repositoryRoot: input.repositoryRoot,
    signal: input.signal,
  });
  const deployCommandDurationMs = Date.now() - commandStartedAt;
  // Wrangler prints "Total Upload: … KiB / gzip: … KiB" on every upload —
  // lift it out of the captured deploy output for the PR table's size column.
  const workerSize = parseWorkerSizeFromDeployOutput(
    `${deployResult.stdout}\n${deployResult.stderr}`,
  );
  const sizeFields = {
    workerSizeKib: workerSize?.totalKib ?? null,
    workerGzipKib: workerSize?.gzipKib ?? null,
    mainWorkerGzipKib: workerSize ? (input.mainWorkerSize?.gzipKib ?? null) : null,
  };
  if (deployResult.exitCode !== 0) {
    return CloudflarePreviewAppEntry.parse({
      ...baseEntry,
      ...sizeFields,
      deployCommandDurationMs,
      deployReuseProofDurationMs,
      message: commandFailureMessage(deployResult, "Preview deployment failed."),
      status: "deploy-failed",
    });
  }
  const deployedAt = new Date().toISOString();

  const deployedWorkerVersion = parseLastDeployedWorkerVersionId(
    `${deployResult.stdout}\n${deployResult.stderr}`,
  );
  if (!deployedWorkerVersion) {
    return CloudflarePreviewAppEntry.parse({
      ...baseEntry,
      ...sizeFields,
      deployedAt,
      deployCommandDurationMs,
      deployReuseProofDurationMs,
      message:
        "Preview deployment succeeded, but wrangler did not report the exact Worker version required by preview tests.",
      status: "deploy-failed",
    });
  }

  const readinessStartedAt = Date.now();
  const readiness = await waitForPreviewAppReadiness({
    publicUrl: appConfig.baseUrl,
    readyUrlPath: input.app.previewReadyUrlPath,
    signal: input.signal,
    timeoutMs: defaultPreviewReadyTimeoutMs,
    workerVersion:
      deployedWorkerVersion && input.app.previewReadyWorkerVersion
        ? { expected: deployedWorkerVersion }
        : undefined,
  });
  const deployReadinessDurationMs = Date.now() - readinessStartedAt;
  if (!readiness.ok) {
    return CloudflarePreviewAppEntry.parse({
      ...baseEntry,
      ...sizeFields,
      deployedAt,
      deployCommandDurationMs,
      deployReadinessDurationMs,
      deployReuseProofDurationMs,
      message: readiness.message,
      status: "deploy-failed",
    });
  }

  return CloudflarePreviewAppEntry.parse({
    ...baseEntry,
    ...sizeFields,
    deployedAt,
    deployCommandDurationMs,
    deployReadinessDurationMs,
    deployReuseProofDurationMs,
    deployedWorkerName: appConfig.workerName,
    deployedWorkerVersion,
    deployedFingerprint: fingerprint,
    status: "awaiting-tests",
  });
}

function readPreviewAppConfig(input: { app: PreviewAppRuntime; dopplerConfig: string }) {
  const PreviewAppConfig = z.object({
    baseUrl: z.string().trim().url(),
    projectHostnameBases: z.array(z.string().trim().min(1)).default([]),
    workerName: z.string().trim().min(1),
  });
  return PreviewAppConfig.parse(input.app.resolvePreviewAppConfig(input.dopplerConfig));
}

async function runPreviewDeployCommand(input: {
  app: PreviewAppRuntime;
  commandEnvironment: NodeJS.ProcessEnv;
  dopplerConfig: string;
  repositoryRoot: string;
  signal?: AbortSignal;
}) {
  return await runCommand({
    args: [
      "run",
      "--project",
      input.app.dopplerProject,
      "--config",
      input.dopplerConfig,
      "--",
      ...input.app.deployCommandArgs,
    ],
    command: "doppler",
    environment: input.commandEnvironment,
    signal: input.signal,
    workingDirectory: resolve(input.repositoryRoot, input.app.appPath),
  });
}

/**
 * Destroy a preview environment before handing the slot to a new holder.
 * Reclaim paths MUST run this: a reclaim only ever happens because the
 * previous holder's cleanup — which normally destroys on the way out — failed
 * or never ran. Deploying over stale identity data breaks the next tenant
 * (observed 2026-07-07 on
 * preview-5: 208 orphaned project-directory KV keys against an empty auth D1
 * → every itx project lookup answered "KV GET failed: 500").
 */
type DestroyPreviewEnvironment = (input: {
  dopplerConfig: string;
  signal?: AbortSignal;
  slug: string;
}) => Promise<void>;

function makePreviewEnvironmentDestroyer(runtime: {
  signal?: AbortSignal;
}): DestroyPreviewEnvironment {
  return async ({ dopplerConfig, signal, slug }) => {
    const startedAt = Date.now();
    logPreview(`destroying ${slug} before handover (environment ${dopplerConfig})`);
    await destroyManagedEnvironment(
      environmentStage(dopplerConfig),
      runtime.signal && signal
        ? AbortSignal.any([runtime.signal, signal])
        : (signal ?? runtime.signal),
    );
    logPreview(`destroyed ${slug} (${formatDurationMs(Date.now() - startedAt)})`);
  };
}

async function withLeaseFence<A>(input: {
  lease: { leaseId: string; slug: string; type: string };
  leaseMs: number;
  operation: (signal: AbortSignal) => Promise<A>;
  renewEveryMs?: number;
  semaphore: PreviewSemaphoreResourceClient;
  signal?: AbortSignal;
}): Promise<A> {
  const ownershipLost = new AbortController();
  const operationSignal = input.signal
    ? AbortSignal.any([input.signal, ownershipLost.signal])
    : ownershipLost.signal;
  const renewalIntervalMs =
    input.renewEveryMs ?? Math.max(1_000, Math.min(input.leaseMs / 3, 5 * 60_000));
  let renewalFailure: unknown;
  let renewalQueue = Promise.resolve();

  const renew = () => {
    const result = renewalQueue.then(async () => {
      if (renewalFailure !== undefined) throw renewalFailure;
      const renewed = await input.semaphore.renew({
        type: input.lease.type,
        slug: input.lease.slug,
        leaseId: input.lease.leaseId,
        leaseMs: input.leaseMs,
      });
      if (renewed === null) {
        throw new Error(
          `Lease ownership lost for ${input.lease.slug}; destructive work was fenced off.`,
        );
      }
      if (
        renewed.type !== input.lease.type ||
        renewed.slug !== input.lease.slug ||
        renewed.leaseId !== input.lease.leaseId
      ) {
        throw new Error(
          `Semaphore returned a mismatched lease while fencing ${input.lease.slug}; destructive work was fenced off.`,
        );
      }
      return renewed;
    });
    renewalQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  // Exact-token renewal is both the ownership check and the first extension.
  // A list snapshot or matching holder string is never sufficient authority.
  await renew();
  const interval = setInterval(() => {
    void renew().catch((error: unknown) => {
      if (renewalFailure !== undefined) return;
      renewalFailure = error;
      ownershipLost.abort(error);
    });
  }, renewalIntervalMs);

  try {
    const result = await input.operation(operationSignal);
    if (renewalFailure !== undefined) throw renewalFailure;
    // Fence completion too: callers may release only an uninterrupted lease.
    await renew();
    return result;
  } finally {
    clearInterval(interval);
  }
}

async function destroyEnvironmentUnderLease(input: {
  destroyEnvironment: DestroyPreviewEnvironment;
  dopplerConfig: string;
  lease: { leaseId: string; slug: string; type: string };
  leaseMs: number;
  semaphore: PreviewSemaphoreResourceClient;
  signal?: AbortSignal;
}): Promise<void> {
  await withLeaseFence({
    lease: input.lease,
    leaseMs: input.leaseMs,
    semaphore: input.semaphore,
    signal: input.signal,
    operation: async (signal) => {
      await input.destroyEnvironment({
        dopplerConfig: input.dopplerConfig,
        signal,
        slug: input.lease.slug,
      });
    },
  });
}

function logPreview(message: string) {
  console.error(`[preview] ${message}`);
}

/** `pr-1234` — the lease holder id the PR flow records in semaphore. */
function pullRequestHolder(pullRequestNumber: number) {
  return `pr-${pullRequestNumber}`;
}

function holderPullRequestUrl(holder: string | null | undefined) {
  const match = /^pr-(\d+)$/.exec(holder ?? "");
  const repositoryFullName = process.env.GITHUB_REPOSITORY?.trim() || defaultRepositoryFullName;
  return match ? `https://github.com/${repositoryFullName}/pull/${match[1]}` : null;
}

function formatUntil(epochMs: number) {
  const remainingMs = epochMs - Date.now();
  const remaining =
    remainingMs <= 0
      ? "expired"
      : remainingMs < 60_000
        ? `${Math.round(remainingMs / 1000)}s left`
        : `${Math.floor(remainingMs / 3_600_000)}h${Math.round((remainingMs % 3_600_000) / 60_000)}m left`;
  return `${new Date(epochMs).toISOString()} (${remaining})`;
}

/** One line per slot — `preview-2  leased by pr-1601 until ... | https://github.com/...` — for error messages and logs. */
async function describeEnvironmentConfigLeases(semaphore: PreviewSemaphoreResourceClient) {
  const resources = await semaphore.list({ type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE });
  return resources
    .map((resource) => {
      if (resource.leaseState !== "leased" || resource.leasedUntil === null) {
        return `  ${resource.slug}  available`;
      }

      const holder = resource.holder ?? "unknown holder";
      const prUrl = holderPullRequestUrl(resource.holder);
      return `  ${resource.slug}  leased by ${holder} until ${formatUntil(resource.leasedUntil)}${prUrl ? ` | ${prUrl}` : ""}`;
    })
    .join("\n");
}

function isNoSlotAvailableError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  const status = (error as { status?: unknown }).status;
  return code === "CONFLICT" || status === 409;
}

// How long `preview deploy` queues for a slot when every slot is leased.
// Contention is expected with many PRs in flight: instead of failing (or
// worse, stealing a slot), the deploy waits its turn and logs who holds what
// while it waits. Override with PREVIEW_SLOT_WAIT_MS=0 to fail fast.
// Bounded so a slotless (or broken-slot) run fails LOUDLY inside the job's
// 15-minute ceiling instead of being killed silently by it: 2026-07-09's
// unerasable-slot loop burned this entire budget per attempt, and external
// retries stacked those into 15-30 minute walls. 6 minutes still rides out
// a normal handover (cleanup of a closing PR takes ~2m); a genuinely full
// fleet surfaces as a failed check with the holder table.
const defaultSlotWaitTotalMs = 6 * 60 * 1000;
// Semaphore caps a single acquire long-poll at 5 minutes; loop to go longer.
const slotWaitPerAttemptMs = 5 * 60 * 1000;

function resolveSlotWaitTotalMs(env: NodeJS.ProcessEnv) {
  const raw = env.PREVIEW_SLOT_WAIT_MS?.trim();
  if (!raw) {
    return defaultSlotWaitTotalMs;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`PREVIEW_SLOT_WAIT_MS must be a non-negative number, got ${raw}.`);
  }

  return parsed;
}

// A hold with no deploy/test renewal for this long counts as idle in
// `preview reclaim` verdicts. Renewals happen on every deploy/test run, so
// idle means "that PR/person hasn't touched the slot in this window". Matches
// the lease TTL (defaultPreviewLeaseMs, 3h): a slot idle this long has a lease
// at or past expiry, and the GC sweep will reclaim it.
const defaultReclaimMinIdleHours = 3;

/** `unknown` = the check itself failed; distinct from "not checked" (null downstream). */
type PullRequestStateFetcher = (
  pullRequestNumber: number,
) => Promise<"open" | "closed" | "unknown">;

function makePullRequestStateFetcher(
  githubToken: string,
  repositoryFullName: string,
): PullRequestStateFetcher {
  const octokit = new Octokit({ auth: githubToken });
  const [owner, repo] = splitRepositoryFullName(repositoryFullName);
  return async (pullRequestNumber) => {
    try {
      const pullRequest = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: pullRequestNumber,
      });
      return pullRequest.data.state === "open" ? "open" : "closed";
    } catch (error) {
      // Unknown beats wrong: a failed check must never trigger a force
      // reclaim, so the slot is treated as active — but say so, since it
      // also suppresses orphan detection.
      logPreview(
        `could not check the state of PR #${pullRequestNumber} (${formatPreviewErrorMessage(error)}) — treating its lease as active`,
      );
      return "unknown";
    }
  };
}

/**
 * Resolve the GitHub token, repo, and PR-state fetcher shared by `status` and
 * `reclaim`. Token precedence: explicit option → GITHUB_TOKEN → `gh auth token`.
 * `fetchPullRequestState` is null when no token is available — callers log their
 * own reason and fall back to idle-time-only verdicts.
 */
function resolvePreviewGithubContext(runtime: PreviewRuntime, options: { githubToken?: string }) {
  const githubToken =
    options.githubToken?.trim() ||
    runtime.commandEnvironment.GITHUB_TOKEN?.trim() ||
    tryReadGhAuthToken();
  const repositoryFullName =
    runtime.commandEnvironment.GITHUB_REPOSITORY?.trim() || defaultRepositoryFullName;
  const fetchPullRequestState = githubToken
    ? makePullRequestStateFetcher(githubToken, repositoryFullName)
    : null;
  return { githubToken, repositoryFullName, fetchPullRequestState };
}

/** Pure reporting verdict; it never authorizes an automatic lease takeover. */
function classifyLeaseForReclaim(input: {
  holderPullRequestState: "open" | "closed" | "unknown" | null;
  lastAcquiredAt: number | null;
  leaseState: "available" | "leased";
  minIdleMs: number;
  now: number;
}): "available" | "active" | "idle" | "orphaned" {
  if (input.leaseState !== "leased") {
    return "available";
  }
  if (input.holderPullRequestState === "closed") {
    // Cleanup may still be running immediately after close. Call this an
    // orphan candidate for operator visibility, but never use the verdict to
    // authorize automation to force-acquire the live lease.
    return "orphaned";
  }
  if (input.holderPullRequestState === "unknown") {
    // The GitHub check failed, so we cannot rule out an open PR. Report the
    // hold as active rather than implying that an operator should reclaim it.
    return "active";
  }
  if (input.lastAcquiredAt !== null && input.now - input.lastAcquiredAt >= input.minIdleMs) {
    return "idle";
  }

  return "active";
}

type PreviewDiagnosisOpenPullRequest = {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  labels: string[];
};

/**
 * Draft PRs only claim a slot when they opt in (same policy as deploy). Used
 * by `preview status` so open PR demand is not compared apples-to-oranges
 * with the available fleet.
 */
function pullRequestWouldClaimPreviewSlot(pullRequest: {
  isDraft: boolean;
  labels: readonly string[];
}): boolean {
  return !pullRequest.isDraft || pullRequest.labels.includes(previewOptInLabel);
}

type PreviewDiagnosisSlot = {
  slug: string;
  verdict: "available" | "active" | "idle" | "orphaned";
  holder: string | null;
  pullRequestUrl: string | null;
  pullRequestState: "open" | "closed" | "unknown" | null;
  leasedUntil: string | null;
  lastUsedAgo: string | null;
};

/**
 * Pure capacity diagnosis: reconcile semaphore holders with open PRs so an
 * operator can see why "only N open PRs" still means zero free slots.
 */
function diagnosePreviewFleetCapacity(input: {
  openPullRequests: PreviewDiagnosisOpenPullRequest[];
  slots: PreviewDiagnosisSlot[];
}) {
  const available = input.slots.filter((slot) => slot.verdict === "available");
  const leased = input.slots.filter((slot) => slot.verdict !== "available");
  const orphaned = leased.filter((slot) => slot.verdict === "orphaned");
  const idle = leased.filter((slot) => slot.verdict === "idle");
  const active = leased.filter((slot) => slot.verdict === "active");
  const holdersWithOpenPrs = input.openPullRequests
    .map((pullRequest) => pullRequest.number)
    .filter((number) => leased.some((slot) => parsePullRequestHolder(slot.holder) === number));
  const previewEligibleOpen = input.openPullRequests.filter(pullRequestWouldClaimPreviewSlot);
  const previewEligibleWithoutSlot = previewEligibleOpen.filter(
    (pullRequest) => !holdersWithOpenPrs.includes(pullRequest.number),
  );
  // Drafts that opted in via a one-shot `--allow-draft` dispatch hold a slot
  // without the label, so exclude any that actually hold one — otherwise we'd
  // tell the operator it "correctly claims no slot" next to holdsSlot: true.
  const openButIneligible = input.openPullRequests.filter(
    (pullRequest) =>
      !pullRequestWouldClaimPreviewSlot(pullRequest) &&
      !holdersWithOpenPrs.includes(pullRequest.number),
  );
  const closedHolders = leased.filter((slot) => slot.pullRequestState === "closed");
  const nonPrHolders = leased.filter((slot) => parsePullRequestHolder(slot.holder) === null);

  const reasons: string[] = [];
  if (available.length === 0 && leased.length > 0) {
    reasons.push(`All ${leased.length} preview slots are leased (0 available).`);
  } else if (available.length > 0) {
    reasons.push(`${available.length} of ${input.slots.length} slots are available.`);
  }
  if (closedHolders.length > 0) {
    reasons.push(
      `${closedHolders.length} leased by closed/merged PRs (cleanup failed or never ran): ${closedHolders
        .map((slot) => `${slot.slug}←${slot.holder}`)
        .join(", ")}.`,
    );
  }
  if (idle.length > 0) {
    reasons.push(
      `${idle.length} idle (open holder, no deploy/test renewal recently): ${idle
        .map(
          (slot) =>
            `${slot.slug}←${slot.holder}${slot.lastUsedAgo ? ` (${slot.lastUsedAgo})` : ""}`,
        )
        .join(", ")}.`,
    );
  }
  if (nonPrHolders.length > 0) {
    reasons.push(
      `${nonPrHolders.length} held by non-PR holders (manual/reclaim): ${nonPrHolders
        .map((slot) => `${slot.slug}←${slot.holder ?? "unknown"}`)
        .join(", ")}.`,
    );
  }
  if (previewEligibleWithoutSlot.length > 0) {
    reasons.push(
      `${previewEligibleWithoutSlot.length} open preview-eligible PR(s) have no slot: ${previewEligibleWithoutSlot
        .map((pullRequest) => `#${pullRequest.number}`)
        .join(", ")}.`,
    );
  }
  if (openButIneligible.length > 0) {
    reasons.push(
      `${openButIneligible.length} open draft PR(s) without the \`${previewOptInLabel}\` label correctly claim no slot: ${openButIneligible
        .map((pullRequest) => `#${pullRequest.number}`)
        .join(", ")}.`,
    );
  }
  if (
    input.openPullRequests.length > 0 &&
    closedHolders.length === 0 &&
    available.length === 0 &&
    previewEligibleOpen.length <= input.slots.length
  ) {
    reasons.push(
      `Open-PR count alone (${input.openPullRequests.length} open, ${previewEligibleOpen.length} preview-eligible) does not explain a full fleet — check idle/manual holders above.`,
    );
  }

  const reclaimCommands = [...orphaned, ...idle].map(
    (slot) => `pnpm preview reclaim --slot ${slot.slug} --force`,
  );

  const summaryParts = [
    `${available.length} available / ${leased.length} leased of ${input.slots.length}`,
    closedHolders.length > 0 ? `${closedHolders.length} orphaned (closed PR)` : null,
    idle.length > 0 ? `${idle.length} idle` : null,
    active.length > 0 ? `${active.length} active` : null,
    previewEligibleWithoutSlot.length > 0
      ? `${previewEligibleWithoutSlot.length} open PR(s) waiting for a slot`
      : null,
  ].filter(Boolean);

  return {
    availableCount: available.length,
    leasedCount: leased.length,
    orphanedCount: orphaned.length,
    idleCount: idle.length,
    activeCount: active.length,
    openPullRequestCount: input.openPullRequests.length,
    previewEligibleOpenCount: previewEligibleOpen.length,
    previewEligibleWithoutSlotCount: previewEligibleWithoutSlot.length,
    holdersWithOpenPrs,
    nextLeaseExpiryAt:
      leased
        .map((slot) => slot.leasedUntil)
        .filter((value): value is string => value != null)
        .sort()[0] ?? null,
    reasons,
    reclaimCommands,
    summary: summaryParts.join(" · "),
  };
}

async function listOpenPullRequestsForPreviewDiagnosis(
  githubToken: string,
  repositoryFullName: string,
): Promise<PreviewDiagnosisOpenPullRequest[]> {
  const octokit = new Octokit({ auth: githubToken });
  const [owner, repo] = splitRepositoryFullName(repositoryFullName);
  const pullRequests = await octokit.paginate(octokit.rest.pulls.list, {
    owner,
    repo,
    state: "open",
    per_page: 100,
  });
  return pullRequests.map((pullRequest) => ({
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.html_url,
    isDraft: Boolean(pullRequest.draft),
    labels: (pullRequest.labels ?? [])
      .map((label) => (typeof label === "string" ? label : label.name))
      .filter((name): name is string => typeof name === "string" && name.length > 0),
  }));
}

async function classifyEnvironmentConfigLeases(input: {
  fetchPullRequestState: PullRequestStateFetcher | null;
  minIdleMs: number;
  semaphore: PreviewSemaphoreResourceClient;
}) {
  const now = Date.now();
  const resources = await input.semaphore.list({ type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE });
  return await Promise.all(
    resources.map(async (resource) => {
      const holder = resource.holder ?? null;
      const holderPullRequestNumber = parsePullRequestHolder(holder);
      const holderPullRequestState =
        resource.leaseState === "leased" && holderPullRequestNumber && input.fetchPullRequestState
          ? await input.fetchPullRequestState(holderPullRequestNumber)
          : null;
      const verdict = classifyLeaseForReclaim({
        holderPullRequestState,
        lastAcquiredAt: resource.lastAcquiredAt,
        leaseState: resource.leaseState,
        minIdleMs: input.minIdleMs,
        now,
      });

      return {
        slug: resource.slug,
        verdict,
        dopplerConfig: parseEnvironmentConfigLeaseData(resource.data).dopplerConfig,
        holder,
        pullRequestUrl: holderPullRequestUrl(holder),
        pullRequestState: holderPullRequestState,
        leasedUntil:
          resource.leasedUntil === null ? null : new Date(resource.leasedUntil).toISOString(),
        lastUsedAt:
          resource.lastAcquiredAt === null ? null : new Date(resource.lastAcquiredAt).toISOString(),
        lastUsedAgo:
          resource.lastAcquiredAt === null
            ? null
            : `${formatDurationMs(now - resource.lastAcquiredAt)} ago`,
      };
    }),
  );
}

function parsePullRequestHolder(holder: string | null | undefined) {
  const match = /^pr-(\d+)$/.exec(holder ?? "");
  return match ? Number.parseInt(match[1] as string, 10) : null;
}

/**
 * Destroy a just-acquired environment before it is handed to the caller, giving the
 * lease back on failure. Returns true when the slot is clean and ours.
 *
 * This runs on every automated tenant handover, so slot cleanliness is an
 * invariant of entry rather than an assumption about how the previous tenant
 * exited. Every exit path that skips the cleanup destroy (failed cleanup +
 * lease expiry, `release --force`, a run cancelled mid-claim) becomes
 * harmless: whoever picks the slot up next destroys it first. A failed destroy
 * releases the lease; environment-manager retains the non-empty/failed
 * lifecycle for GC. Failure to release is a separate ownership failure and is
 * never hidden.
 */
async function destroyAcquiredEnvironmentOrReleaseLease(input: {
  destroyEnvironment: DestroyPreviewEnvironment;
  lease: { data: Record<string, unknown>; leaseId: string; slug: string; type: string };
  leaseMs: number;
  semaphore: PreviewSemaphoreResourceClient;
}) {
  try {
    const leaseData = parseEnvironmentConfigLeaseData(input.lease.data);
    await destroyEnvironmentUnderLease({
      destroyEnvironment: input.destroyEnvironment,
      dopplerConfig: leaseData.dopplerConfig,
      lease: input.lease,
      leaseMs: input.leaseMs,
      semaphore: input.semaphore,
    });
    return true;
  } catch (error) {
    logPreview(
      `destroy failed on just-acquired ${input.lease.slug} — giving the lease back; environment-manager retains the failed cleanup obligation: ${error instanceof Error ? error.message : String(error)}`,
    );
    let released: { released: boolean };
    try {
      released = await input.semaphore.release({
        type: input.lease.type,
        slug: input.lease.slug,
        leaseId: input.lease.leaseId,
      });
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        `Destroying ${input.lease.slug} failed, and releasing its lease also failed.`,
      );
    }
    if (!released.released) {
      throw new AggregateError(
        [error],
        `Destroying ${input.lease.slug} failed, and its lease could not be released because ownership changed.`,
      );
    }
    return false;
  }
}

/**
 * Acquire any free slot, queueing (via semaphore long-poll) while all slots
 * are leased. Automation never force-acquires a held slot: a close-triggered
 * cleanup owns its lease until teardown finishes and releases it, which keeps
 * another PR from destroying or deploying into that slot concurrently. Every
 * handed-over slot is destroyed first (see destroyAcquiredEnvironmentOrReleaseLease). Fails
 * with the full holder table and remediation steps once `waitTotalMs` elapses.
 */
async function acquireAnyEnvironmentConfigLease(input: {
  semaphore: PreviewSemaphoreResourceClient;
  /** Required so no acquire path can hand over a slot without destroying it. */
  destroyEnvironment: DestroyPreviewEnvironment;
  holder: string;
  leaseMs: number;
  onFirstWait?: (holderTable: string) => Promise<void>;
  waitTotalMs: number;
}) {
  const deadline = Date.now() + input.waitTotalMs;
  let attempt = 0;
  // A failed handover identifies a broken slot for this invocation. Exclude it
  // from later acquires so another free slot can make progress without retry
  // loops or control-plane spam.
  const failedSlugs = new Set<string>();

  for (;;) {
    attempt += 1;
    const remainingMs = deadline - Date.now();
    // The first attempt returns immediately so contention is surfaced before
    // any long-poll; later attempts queue on the semaphore in 5-minute polls.
    const waitMs = attempt === 1 ? 0 : Math.max(0, Math.min(slotWaitPerAttemptMs, remainingMs));
    try {
      const allowedSlugs = previewEnvironmentSlugs.filter((slug) => !failedSlugs.has(slug));
      if (allowedSlugs.length === 0) {
        throw new Error(
          `Could not hand ${input.holder} a clean slot: every eligible preview slot failed destruction during this run (${[...failedSlugs].join(", ")}).`,
        );
      }
      const acquired = await input.semaphore.acquire({
        allowedSlugs,
        type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
        leaseMs: input.leaseMs,
        waitMs,
        holder: input.holder,
      });
      if (
        await destroyAcquiredEnvironmentOrReleaseLease({
          destroyEnvironment: input.destroyEnvironment,
          lease: acquired,
          leaseMs: input.leaseMs,
          semaphore: input.semaphore,
        })
      ) {
        return acquired;
      }
      // Bound the acquire→failed-destroy→release cycle: without this check the
      // loop would spin on a free-but-unerasable slot past the wait budget.
      if (Date.now() >= deadline) {
        throw new Error(
          `Could not hand ${input.holder} a clean slot: destroying ${acquired.slug} kept failing and the ${formatDurationMs(input.waitTotalMs)} wait budget is spent.`,
        );
      }
      failedSlugs.add(acquired.slug);
      logPreview(`${acquired.slug} failed destroy — excluding it from this acquisition run.`);
      continue;
    } catch (error) {
      if (!isNoSlotAvailableError(error)) {
        throw error;
      }

      if (attempt === 1) {
        logPreview("all slots leased — waiting for an owner to release one");
      }

      const holderTable = await describeEnvironmentConfigLeases(input.semaphore);
      if (attempt === 1 && input.onFirstWait) {
        try {
          await input.onFirstWait(holderTable);
        } catch (noticeError) {
          logPreview(`could not surface the wait: ${formatPreviewErrorMessage(noticeError)}`);
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(
          [
            `No preview slot became available for ${input.holder} after waiting ${formatDurationMs(input.waitTotalMs)}.`,
            "Current slots:",
            holderTable,
            "Every slot is still leased. Automation never force-reclaims a held slot because its owner may be cleaning it up. Options:",
            "  - re-run once a slot frees up (leases release when their PR closes)",
            "  - inspect idle/orphaned holds: doppler run --project _shared --config prd -- pnpm preview reclaim",
            "  - after verifying no cleanup/deploy is running, reclaim one explicitly: doppler run --project _shared --config prd -- pnpm preview reclaim --slot N --force",
            "  - close or merge stale PRs holding slots",
          ].join("\n"),
        );
      }

      logPreview(
        `all slots leased; waiting for one to free up (attempt ${attempt}, ${formatDurationMs(Math.max(0, deadline - Date.now()))} left)\n${holderTable}`,
      );
    }
  }
}

/**
 * Claim a slot for a PR deploy, with Semaphore as the single source of lease
 * truth.
 *
 * 1. Renew the recorded exact lease token. Only this uninterrupted lease may
 *    preserve the deployment already on the slot.
 * 2. Re-take the recorded slot when its lease lapsed but nobody else claimed
 *    it, then destroy it. A lapsed lease has an ownership gap, so the old
 *    deployment can never be trusted even if the slug stayed free.
 * 3. Otherwise queue for any free slot.
 *
 * A lease acquired by a cancelled run before its token reached the PR body is
 * deliberately not recovered from a holder-name snapshot. Recovery without
 * the fencing token was the race: the unrecorded lease expires normally, and a
 * later GC cleans its manager state.
 */
async function claimEnvironmentConfigLease(input: {
  destroyEnvironment: DestroyPreviewEnvironment;
  holder: string;
  leaseMs: number;
  onFirstWait?: (holderTable: string) => Promise<void>;
  recordedLease: CloudflarePreviewLeaseReference | null;
  semaphore: PreviewSemaphoreResourceClient;
  waitTotalMs: number;
}) {
  const renewed = await renewRecordedEnvironmentConfigLease({
    holder: input.holder,
    leaseMs: input.leaseMs,
    recordedLease: input.recordedLease,
    semaphore: input.semaphore,
  });
  if (renewed) {
    return { lease: renewed, stackWasDestroyed: false };
  }

  const retaken = await takeAndCleanRecordedSlotIfFree({
    destroyEnvironment: input.destroyEnvironment,
    holder: input.holder,
    leaseMs: input.leaseMs,
    recordedSlug: input.recordedLease?.slug ?? null,
    semaphore: input.semaphore,
  });
  if (retaken) {
    return { lease: retaken, stackWasDestroyed: true };
  }

  const lease = await acquireAnyEnvironmentConfigLease({
    semaphore: input.semaphore,
    destroyEnvironment: input.destroyEnvironment,
    holder: input.holder,
    leaseMs: input.leaseMs,
    onFirstWait: input.onFirstWait,
    waitTotalMs: input.waitTotalMs,
  });
  logPreview(
    `lease acquired: ${lease.slug} held by ${input.holder} until ${formatUntil(lease.expiresAt)}`,
  );
  return { lease: toEnvironmentConfigLease(lease), stackWasDestroyed: true };
}

/**
 * Core of `preview assign`: keep the slot whose exact recorded lease token
 * Semaphore renews when it satisfies the request, otherwise take
 * the wanted slot (or any free one) and release the previously-held lease so
 * it doesn't stay claimed against a slot the PR no longer records. Ownership
 * comes from Semaphore; the recorded reference is only an input to exact
 * renewal and an affinity hint after a gap.
 */
async function assignEnvironmentConfigLease(input: {
  destroyEnvironment: DestroyPreviewEnvironment;
  force?: boolean;
  holder: string;
  leaseMs: number;
  recordedLease: CloudflarePreviewLeaseReference | null;
  semaphore: PreviewSemaphoreResourceClient;
  wantedSlug: string | null;
}): Promise<{
  lease: EnvironmentConfigLease;
  outcome: "kept" | "assigned" | "moved";
  changedFromSlug: string | null;
  previousLeaseReleased: boolean;
  stackWasDestroyed: boolean;
}> {
  let heldLease = await renewRecordedEnvironmentConfigLease({
    holder: input.holder,
    leaseMs: input.leaseMs,
    recordedLease: input.recordedLease,
    semaphore: input.semaphore,
  });
  let heldStackWasDestroyed = false;
  if (!heldLease) {
    heldLease = await takeAndCleanRecordedSlotIfFree({
      destroyEnvironment: input.destroyEnvironment,
      holder: input.holder,
      leaseMs: input.leaseMs,
      recordedSlug: input.recordedLease?.slug ?? null,
      semaphore: input.semaphore,
    });
    heldStackWasDestroyed = heldLease !== null;
  }
  if (heldLease && (!input.wantedSlug || input.wantedSlug === heldLease.slug)) {
    return {
      lease: heldLease,
      outcome: "kept",
      changedFromSlug: null,
      previousLeaseReleased: false,
      stackWasDestroyed: heldStackWasDestroyed,
    };
  }

  let lease: EnvironmentConfigLease;
  if (input.wantedSlug) {
    try {
      const currentHolder = await findEnvironmentConfigLeaseHolder(
        input.semaphore,
        input.wantedSlug,
      );
      if (input.force && currentHolder) {
        logPreview(
          `--force: evicting ${currentHolder} from ${input.wantedSlug}. Their deployment on the slot is now fair game.`,
        );
      }

      const acquired = await input.semaphore.acquireSpecific({
        allowedSlugs: previewEnvironmentSlugs,
        leaseMs: input.leaseMs,
        slug: input.wantedSlug,
        type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
        holder: input.holder,
        // Only an explicit human --force may evict an active lease. Matching
        // holder text is not a fencing token and cannot resume a move.
        force: input.force,
      });
      if (!acquired) {
        const currentHolder = await findEnvironmentConfigLeaseHolder(
          input.semaphore,
          input.wantedSlug,
        );
        if (currentHolder) {
          const prUrl = holderPullRequestUrl(currentHolder);
          throw new Error(
            [
              `${input.wantedSlug} is leased by ${currentHolder}${prUrl ? ` (${prUrl})` : ""}.`,
              "Re-run with --force to evict them (their deployment will be clobbered), or pick a free slot:",
              await describeEnvironmentConfigLeases(input.semaphore),
            ].join("\n"),
          );
        }

        throw new Error(
          [
            `${input.wantedSlug} is not a known preview slot. Known slots:`,
            await describeEnvironmentConfigLeases(input.semaphore),
          ].join("\n"),
        );
      }
      // Same entry invariant as every other handover — this also covers a
      // --force eviction, where the acquired slot holds the evicted PR's data.
      const clean = await destroyAcquiredEnvironmentOrReleaseLease({
        destroyEnvironment: input.destroyEnvironment,
        lease: acquired,
        leaseMs: input.leaseMs,
        semaphore: input.semaphore,
      });
      if (!clean) {
        throw new Error(
          `Destroying ${acquired.slug} failed, so its lease was given back rather than assigning it. Retry, or pick another slot.`,
        );
      }
      lease = toEnvironmentConfigLease(acquired);
    } catch (error) {
      if (!heldLease || heldLease.slug === input.recordedLease?.slug) throw error;
      try {
        const released = await input.semaphore.release({
          type: heldLease.type,
          slug: heldLease.slug,
          leaseId: heldLease.leaseId,
        });
        if (!released.released) {
          throw new Error(
            `Lease ownership lost for unrelated held slot ${heldLease.slug} while recovering from a failed assignment.`,
          );
        }
        logPreview(
          `requested slot assignment failed; released unrelated held slot ${heldLease.slug}`,
        );
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          `Requested slot ${input.wantedSlug} could not be assigned, and releasing unrelated held slot ${heldLease.slug} also failed.`,
        );
      }
      throw error;
    }
  } else {
    // A human is asking right now — fail fast with the holder table instead
    // of queueing like CI does.
    lease = toEnvironmentConfigLease(
      await acquireAnyEnvironmentConfigLease({
        semaphore: input.semaphore,
        destroyEnvironment: input.destroyEnvironment,
        holder: input.holder,
        leaseMs: input.leaseMs,
        waitTotalMs: 0,
      }),
    );
  }
  logPreview(
    `lease assigned: ${lease.slug} held by ${input.holder} until ${formatUntil(lease.leasedUntil)}`,
  );

  let previousLeaseReleased = false;
  if (heldLease && heldLease.slug !== lease.slug) {
    const released = await input.semaphore.release({
      type: heldLease.type,
      slug: heldLease.slug,
      leaseId: heldLease.leaseId,
    });
    if (!released.released) {
      throw new Error(
        `Lease ownership lost for previous slot ${heldLease.slug} while completing assignment.`,
      );
    }
    previousLeaseReleased = true;
    logPreview(
      `previous slot ${heldLease.slug} released — any deployment still there is now unprotected`,
    );
  }

  const previousSlug = heldLease?.slug ?? input.recordedLease?.slug ?? null;
  return {
    lease,
    outcome: heldLease ? "moved" : "assigned",
    changedFromSlug: previousSlug && previousSlug !== lease.slug ? previousSlug : null,
    previousLeaseReleased,
    stackWasDestroyed: true,
  };
}

function toEnvironmentConfigLease(lease: {
  data: Record<string, unknown>;
  expiresAt: number;
  leaseId: string;
  slug: string;
  type: string;
}) {
  const data = parseEnvironmentConfigLeaseData(lease.data);
  return {
    dopplerConfig: data.dopplerConfig,
    leasedUntil: lease.expiresAt,
    leaseId: lease.leaseId,
    slug: lease.slug,
    type: lease.type,
  } satisfies EnvironmentConfigLease;
}

/** The slots Semaphore currently attributes to this holder. */
async function listSlotsLeasedToHolder(semaphore: PreviewSemaphoreResourceClient, holder: string) {
  const resources = await semaphore.list({ type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE });
  return resources.filter(
    (resource) => resource.leaseState === "leased" && resource.holder === holder,
  );
}

/**
 * Prove an uninterrupted lease by renewing its exact recorded fencing token.
 * Holder strings and list snapshots are diagnostic only; neither can recover
 * a missing token or bridge an ownership gap.
 */
async function renewRecordedEnvironmentConfigLease(input: {
  holder: string;
  leaseMs: number;
  recordedLease: CloudflarePreviewLeaseReference | null;
  semaphore: PreviewSemaphoreResourceClient;
}): Promise<EnvironmentConfigLease | null> {
  const recorded = input.recordedLease;
  if (!recorded) {
    const held = await listSlotsLeasedToHolder(input.semaphore, input.holder);
    if (held.length > 1) {
      throw new Error(
        `Semaphore attributes multiple preview leases to ${input.holder}: ${held.map(({ slug }) => slug).join(", ")}. Refusing to choose by holder text; release or expire the untracked lease.`,
      );
    }
    if (held.length > 0) {
      throw new Error(
        `Semaphore attributes ${held.map(({ slug }) => slug).join(", ")} to ${input.holder}, but the PR has no exact lease token. Refusing to recover from holder text; wait for expiry or explicitly reclaim the slot.`,
      );
    }
    return null;
  }

  const renewed = await input.semaphore.renew({
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
    slug: recorded.slug,
    leaseId: recorded.leaseId,
    leaseMs: input.leaseMs,
  });
  if (!renewed) return null;
  if (
    renewed.holder !== input.holder ||
    renewed.slug !== recorded.slug ||
    renewed.leaseId !== recorded.leaseId
  ) {
    throw new Error(
      `Semaphore returned a mismatched lease while renewing ${recorded.slug} for ${input.holder}; refusing to proceed.`,
    );
  }
  const held = await listSlotsLeasedToHolder(input.semaphore, input.holder);
  if (held.length > 1) {
    throw new Error(
      `Semaphore attributes multiple preview leases to ${input.holder}: ${held.map(({ slug }) => slug).join(", ")}. Refusing to choose by holder text; release or expire the untracked lease.`,
    );
  }
  logPreview(
    `lease held: exact token for ${renewed.slug} renewed until ${formatUntil(renewed.expiresAt)}`,
  );
  return toEnvironmentConfigLease(renewed);
}

/**
 * Take a lapsed recorded slot only if it is still free, then destroy it before
 * returning it. The semaphore arbitrates the non-force acquire, but a PR-body
 * slug cannot prove uninterrupted ownership: another tenant may have occupied
 * and released the slot during the gap.
 */
async function takeAndCleanRecordedSlotIfFree(input: {
  destroyEnvironment: DestroyPreviewEnvironment;
  holder: string;
  leaseMs: number;
  recordedSlug: string | null;
  semaphore: PreviewSemaphoreResourceClient;
}): Promise<EnvironmentConfigLease | null> {
  if (!input.recordedSlug) {
    return null;
  }
  const retaken = await input.semaphore.acquireSpecific({
    allowedSlugs: previewEnvironmentSlugs,
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
    slug: input.recordedSlug,
    leaseMs: input.leaseMs,
    holder: input.holder,
  });
  if (!retaken) {
    return null;
  }
  logPreview(
    `lease re-acquired after an ownership gap: ${retaken.slug} is held by ${input.holder} until ${formatUntil(retaken.expiresAt)}; destroying before reuse`,
  );
  const clean = await destroyAcquiredEnvironmentOrReleaseLease({
    destroyEnvironment: input.destroyEnvironment,
    lease: retaken,
    leaseMs: input.leaseMs,
    semaphore: input.semaphore,
  });
  if (!clean) {
    throw new Error(`Could not clean re-acquired slot ${retaken.slug}.`);
  }
  return toEnvironmentConfigLease(retaken);
}

/**
 * Why a slot action was refused: the semaphore no longer attributes a slot
 * to this holder. CONTRACT: the message always contains the exact substring
 * "no longer belongs to" — on-call humans grep for it to tell a slot steal
 * apart from ordinary failures.
 */
function describeLostSlotOwnership(input: {
  currentHolder: string | null;
  displaySlot: CloudflarePreviewLeaseReference | null;
  holder: string;
}): string {
  if (!input.displaySlot) {
    return `This PR records deployments, but the semaphore leases no slot to ${input.holder} — the slot they ran on no longer belongs to ${input.holder}.`;
  }

  const prUrl = holderPullRequestUrl(input.currentHolder);
  return [
    `Slot ${input.displaySlot.slug} no longer belongs to ${input.holder}: it is now leased by ${input.currentHolder ?? "someone else"}${prUrl ? ` (${prUrl})` : ""}.`,
    `Their deployment has replaced this PR's apps on ${input.displaySlot.dopplerConfig}.`,
  ].join(" ");
}

async function findEnvironmentConfigLeaseHolder(
  semaphore: PreviewSemaphoreResourceClient,
  slug: string,
) {
  const resources = await semaphore.list({ type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE });
  const resource = resources.find((candidate) => candidate.slug === slug);
  return resource?.leaseState === "leased" ? (resource.holder ?? null) : null;
}

/**
 * The slice of GitHub's compare API the deploy selection needs: the compare
 * status plus the changed filenames. Injectable so unit tests can drive
 * force-push shapes (404s, diverged history) without a network.
 */
type PreviewCompareFetcher = (basehead: string) => Promise<{
  status: string;
  changedFilenames: string[];
}>;

/** The real {@link PreviewCompareFetcher}: GitHub's compare API behind the transient-failure retry. */
function makeGithubCompareFetcher(input: {
  githubToken: string;
  repositoryFullName: string;
}): PreviewCompareFetcher {
  const octokit = new Octokit({ auth: input.githubToken });
  const [owner, repo] = splitRepositoryFullName(input.repositoryFullName);
  return async (basehead) => {
    const comparison = await withGithubRetry("compareCommits", () =>
      octokit.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead }),
    );
    return {
      status: comparison.data.status,
      changedFilenames:
        comparison.data.files?.flatMap((file) => (file.filename ? [file.filename] : [])) ?? [],
    };
  };
}

type PreviewOsContainerRolloutDecision = {
  mode: "immediate" | "none";
  reason: string;
};

/**
 * Skip Wrangler's serial container reconciliation only across one proven,
 * same-slot OS ancestry where every container input is unchanged. This is an
 * optimization boundary, so every unknown shape fails open to the normal full
 * rollout rather than risking stale deployed container configuration.
 */
async function resolvePreviewOsContainerRollout(input: {
  dopplerConfig: string;
  githubToken: string;
  nextSlotSlug: string;
  previousSlotSlug: string | null;
  previousState: CloudflarePreviewState;
  pullRequestHeadSha: string;
  repositoryFullName: string;
  /** Injectable for unit tests; defaults to GitHub's commit comparison. */
  fetchCompare?: PreviewCompareFetcher;
}): Promise<PreviewOsContainerRolloutDecision> {
  const immediate = (reason: string): PreviewOsContainerRolloutDecision => ({
    mode: "immediate",
    reason,
  });
  if (input.previousSlotSlug !== input.nextSlotSlug) {
    return immediate("the preview slot is new or changed");
  }

  const previous = input.previousState.apps.os;
  const currentWorkerName = cloudflarePreviewApps.os.resolvePreviewAppConfig(
    input.dopplerConfig,
  ).workerName;
  if (
    !previous?.headSha ||
    !previous.deployedWorkerVersion ||
    previous.deployedWorkerName !== currentWorkerName ||
    !["awaiting-tests", "deployed", "tests-failed"].includes(previous.status)
  ) {
    return immediate("the same slot has no exact prior OS deployment identity");
  }
  if (previous.headSha === input.pullRequestHeadSha) {
    return {
      mode: "none",
      reason: "the exact OS revision is already proven on this slot",
    };
  }

  const fetchCompare = input.fetchCompare ?? makeGithubCompareFetcher(input);
  let compared: Awaited<ReturnType<PreviewCompareFetcher>>;
  try {
    compared = await fetchCompare(`${previous.headSha}...${input.pullRequestHeadSha}`);
  } catch (error) {
    return immediate(
      `the OS ancestry comparison was unavailable: ${formatPreviewErrorMessage(error)}`,
    );
  }

  const compareHazard = describeForcePushCompareHazard(compared.status);
  if (compareHazard) {
    return immediate(compareHazard);
  }
  // GitHub's compare response caps its file list at 300. Exactly hitting the
  // cap cannot prove that an omitted file was not a container input.
  if (compared.changedFilenames.length >= 300) {
    return immediate("the OS ancestry comparison hit GitHub's 300-file response cap");
  }

  const changedInput = compared.changedFilenames.find((filename) =>
    matchesPreviewPath(filename, osContainerRolloutInputPaths),
  );
  if (changedInput) {
    return immediate(`container input ${changedInput} changed`);
  }

  return {
    mode: "none",
    reason: `no container input changed since ${previous.headSha.slice(0, 7)}`,
  };
}

/**
 * GitHub's three-dot compare diffs the head against the MERGE BASE of the two
 * commits, not against the base commit itself. When the previously deployed
 * head is an ancestor of the current head ("ahead" — the normal push), that
 * is exactly the diff we want. After a force-push that rewrites history the
 * deployed head is no longer an ancestor ("diverged") — or the new head is an
 * ancestor of the deployed one ("behind", a straight rollback) — and the file
 * list misses every change that existed only on the deployed side. The slot
 * still RUNS that code, so apps it touched need a redeploy the diff would
 * never select. Returns the reason to deploy the whole fleet instead, or null
 * when the diff is trustworthy. Over-deploying is idempotent and costs
 * minutes; under-deploying strands force-pushed-away code on the slot.
 */
function describeForcePushCompareHazard(status: string): string | null {
  if (status === "ahead" || status === "identical") {
    return null;
  }

  return `compare status "${status}" means the last deployed head is not an ancestor of the current head (force-push or rollback), so the file diff cannot see changes that existed only on the deployed side`;
}

/** GitHub compare 404s when a force-push rewrote the base commit out of the PR's history. */
function isGithubNotFoundError(error: unknown) {
  return (error as { status?: unknown } | null)?.status === 404;
}

/**
 * One cheap "is this app actually serving?" check against a readiness URL.
 * Returns ok=false with a detail string instead of throwing, so callers treat
 * every failure mode (503, DNS, timeout) uniformly as "not serving".
 */
type PreviewAppServingProbe = (url: URL) => Promise<{ ok: boolean; detail: string }>;

/** Deadline for one {@link PreviewAppServingProbe} GET — a healthy app answers in well under a second. */
const previewServingProbeTimeoutMs = 15_000;

/** The real {@link PreviewAppServingProbe}: a single GET, no polling — this checks a deploy that already passed readiness once. */
async function probePreviewAppServingOnce(url: URL): Promise<{ ok: boolean; detail: string }> {
  try {
    const { status } = await fetchReadinessResponse(url, {
      signal: AbortSignal.timeout(previewServingProbeTimeoutMs),
      timeoutMs: previewServingProbeTimeoutMs,
    });
    return { ok: status >= 200 && status < 300, detail: `HTTP ${status}` };
  } catch (error) {
    return { ok: false, detail: formatPreviewErrorMessage(error) };
  }
}

/**
 * Recorded-green apps ("deployed"/"awaiting-tests") whose deployment is no
 * longer actually serving. A green row is normally trustworthy — but an
 * destroying the slot (the documented remedy when merged-main lands a
 * non-migratable schema change) removes its Workers and data WITHOUT touching
 * the recorded PR-body state. Trusting
 * the stale green rows then redeploys only the failed apps and leaves the slot
 * half-dead: observed 2026-07-09 on preview-7 (PR #1793), where e2e failed
 * with "no such column: epoch", the destroy removed os and emptied auth's D1
 * (OAuth clients), and the retry — os and auth both recorded green — never
 * redeployed either; auth had to be redeployed by hand. Probing each green
 * app's readiness URL once makes destroy + re-run self-healing: the missing
 * app fails its probe, joins the retry selection, and pulls its dependencies
 * (auth, whose OAuth-client seed lives in the destroyed D1) along via
 * expandPreviewDependencies.
 */
async function selectRecordedGreenAppsNotServing(params: {
  alreadySelectedSlugs: ReadonlySet<CloudflarePreviewAppSlugType>;
  previousState: CloudflarePreviewState;
  probeAppServing: PreviewAppServingProbe;
}): Promise<CloudflarePreviewAppSlugType[]> {
  const notServing: CloudflarePreviewAppSlugType[] = [];
  for (const entry of Object.values(params.previousState.apps)) {
    const app = cloudflarePreviewApps[entry.appSlug as CloudflarePreviewAppSlugType];
    if (
      app == null ||
      params.alreadySelectedSlugs.has(app.slug) ||
      !entry.publicUrl ||
      !["awaiting-tests", "deployed"].includes(entry.status)
    ) {
      continue;
    }

    const probeFailures: string[] = [];
    for (const url of resolvePreviewReadinessUrls({
      publicUrl: entry.publicUrl,
      readyUrlPath: app.previewReadyUrlPath,
    })) {
      const probe = await params.probeAppServing(url);
      if (!probe.ok) {
        probeFailures.push(`${url} answered ${probe.detail}`);
      }
    }
    if (probeFailures.length > 0) {
      logPreview(
        `app ${app.slug} selected: recorded ${entry.status} but not actually serving (${probeFailures.join("; ")}) — the environment was likely destroyed since that deploy`,
      );
      notServing.push(app.slug);
    }
  }

  return notServing;
}

async function selectPreviewAppsForPullRequest(input: {
  githubToken: string;
  previousState: CloudflarePreviewState;
  pullRequestBaseSha: string;
  pullRequestHeadSha: string;
  pullRequestNumber: number;
  repositoryFullName: string;
  /** Injectable for tests; defaults to {@link makeGithubCompareFetcher}. */
  fetchCompare?: PreviewCompareFetcher;
  /** Injectable for tests; defaults to {@link probePreviewAppServingOnce}. */
  probeAppServing?: PreviewAppServingProbe;
}) {
  const fetchCompare = input.fetchCompare ?? makeGithubCompareFetcher(input);
  const probeAppServing = input.probeAppServing ?? probePreviewAppServingOnce;

  // Non-green recorded state is retried on EVERY path — not only when the
  // head is unchanged. A push whose diff misses the failed apps must not
  // leave them wedged (see the comment in selectPreviewAppsNeedingRetry).
  const retryApps = selectPreviewAppsNeedingRetry({
    previousState: input.previousState,
  });

  const compareBaseSha = resolvePreviewCompareBaseSha(input);
  const diffSelectedSlugs: CloudflarePreviewAppSlugType[] = [];
  if (compareBaseSha === input.pullRequestHeadSha) {
    logPreview(
      retryApps.length > 0
        ? `head sha unchanged since the last run — retrying apps that didn't reach a green state: ${retryApps.map((app) => app.slug).join(", ")}`
        : "head sha unchanged since the last run and every app finished — nothing to retry",
    );
  } else {
    let compared: Awaited<ReturnType<PreviewCompareFetcher>>;
    try {
      compared = await fetchCompare(`${compareBaseSha}...${input.pullRequestHeadSha}`);
    } catch (error) {
      if (!isGithubNotFoundError(error)) {
        throw error;
      }
      logPreview(
        `compare ${compareBaseSha.slice(0, 7)}...${input.pullRequestHeadSha.slice(0, 7)} returned 404 — a force-push rewrote the last deployed head out of history, so no diff can be trusted; deploying ALL preview apps`,
      );
      return Object.values(cloudflarePreviewApps);
    }

    const compareHazard = describeForcePushCompareHazard(compared.status);
    if (compareHazard) {
      logPreview(`${compareHazard} — deploying ALL preview apps`);
      return Object.values(cloudflarePreviewApps);
    }
    logPreview(
      `selecting apps by diff ${compareBaseSha.slice(0, 7)}...${input.pullRequestHeadSha.slice(0, 7)} (${compared.changedFilenames.length} changed files)`,
    );

    const sharedPathHit = compared.changedFilenames.find((filename) =>
      matchesPreviewPath(filename, cloudflarePreviewSharedPaths),
    );
    if (sharedPathHit) {
      logPreview(
        `shared preview infrastructure changed (${sharedPathHit}) — deploying ALL preview apps`,
      );
      return Object.values(cloudflarePreviewApps);
    }

    for (const app of Object.values(cloudflarePreviewApps)) {
      const hit = compared.changedFilenames.find((filename) =>
        matchesPreviewPath(filename, app.paths),
      );
      if (hit) {
        logPreview(`app ${app.slug} selected: ${hit} changed`);
        diffSelectedSlugs.push(app.slug);
      }
    }
  }

  const selectedSlugs = new Set<CloudflarePreviewAppSlugType>([
    ...diffSelectedSlugs,
    ...retryApps.map((app) => app.slug),
  ]);
  for (const slug of await selectRecordedGreenAppsNotServing({
    alreadySelectedSlugs: selectedSlugs,
    previousState: input.previousState,
    probeAppServing,
  })) {
    selectedSlugs.add(slug);
  }

  const expanded = expandPreviewDependencies([...selectedSlugs]);
  for (const slug of expanded) {
    if (!selectedSlugs.has(slug)) {
      logPreview(`app ${slug} added as a dependency of the selected apps`);
    }
  }

  return expanded.map((slug) => cloudflarePreviewApps[slug]);
}

function selectPreviewAppsNeedingRetry(params: { previousState: CloudflarePreviewState }) {
  // Any non-green state is retried regardless of which head produced it. For
  // the failed statuses: a slot whose deploy failed at an OLD head stays
  // wedged if the next push's diff doesn't select those apps (observed: an
  // envs.ts-only fix push selected nothing, deploy skipped "nothing to
  // deploy", the test lane then skipped its stale recorded apps and the
  // whole check went GREEN on a slot with three deploy-failed apps). For
  // awaiting-tests: at any head it means a deploy landed and its e2e never
  // ran (a cancelled run), so redeploying it at the current head is the only
  // valid route back to a tested state. A recorded green that lacks its exact
  // immutable Worker identity is also untestable: select it once so legacy or
  // stale PR-body state self-heals instead of failing every future run.
  const recordedSlot = params.previousState.environmentConfigLease;
  const retrySlugs = Object.values(params.previousState.apps)
    .filter((entry) => {
      if (
        ["awaiting-tests", "claim-failed", "deploy-failed", "tests-failed"].includes(entry.status)
      ) {
        return true;
      }
      if (entry.status !== "deployed") return false;

      const app = cloudflarePreviewApps[entry.appSlug as CloudflarePreviewAppSlugType];
      const expectedWorkerName = recordedSlot
        ? app?.resolvePreviewAppConfig(recordedSlot.dopplerConfig).workerName
        : null;
      return (
        !entry.publicUrl ||
        !entry.deployedWorkerVersion ||
        !expectedWorkerName ||
        entry.deployedWorkerName !== expectedWorkerName
      );
    })
    .map((entry) => CloudflarePreviewAppSlug.parse(entry.appSlug));

  return expandPreviewDependencies(retrySlugs).map((slug) => cloudflarePreviewApps[slug]);
}

/**
 * Every runnable deployment participates in every PR-head e2e check. The
 * deployment may come from an older head when the deploy selector proved that
 * none of that app's inputs changed; its immutable Worker version is pinned by
 * {@link resolvePreviewTestWorkerVersionOverrides}. Only deployment work is
 * reusable — test results never are.
 */
function selectPreviewAppsForTesting(
  apps: Partial<Record<string, CloudflarePreviewAppEntry>>,
): PreviewAppRuntime[] {
  return Object.values(apps)
    .filter(
      (entry): entry is CloudflarePreviewAppEntry => entry != null && canRunPreviewTests(entry),
    )
    .map((entry) => cloudflarePreviewApps[entry.appSlug as CloudflarePreviewAppSlugType])
    .filter((app): app is PreviewAppRuntime => app != null);
}

function expandPreviewDependencies(appSlugs: readonly CloudflarePreviewAppSlugType[]) {
  const selected = new Set(appSlugs);
  const visit = (appSlug: CloudflarePreviewAppSlugType) => {
    const app = cloudflarePreviewApps[appSlug];
    for (const dependency of app.previewDependencies ?? []) {
      if (selected.has(dependency)) {
        continue;
      }

      selected.add(dependency);
      visit(dependency);
    }
  };

  for (const appSlug of appSlugs) {
    visit(appSlug);
  }

  return Object.values(cloudflarePreviewApps)
    .map((app) => app.slug)
    .filter((appSlug) => selected.has(appSlug));
}

function orderPreviewDeployBatches(apps: readonly PreviewAppRuntime[]) {
  // Dependencies select a coherent set; they are not ordering constraints.
  // Each app's deploy command owns its readiness checks, so start the fleet together.
  return apps.length === 0 ? [] : [[...apps]];
}

async function mapWithConcurrency<T, Result>(
  items: readonly T[],
  concurrency: number,
  mapItem: (item: T, index: number) => Promise<Result>,
) {
  const results = new Array<Result>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(items.length, concurrency);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapItem(items[index] as T, index);
      }
    }),
  );

  return results;
}

async function waitForPreviewAppReadiness(params: {
  publicUrl: string;
  readyUrlPath?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  workerVersion?: { expected: string };
}) {
  const urls = resolvePreviewReadinessUrls({
    publicUrl: params.publicUrl,
    readyUrlPath: params.readyUrlPath,
  });

  for (const url of urls) {
    const readiness = await waitForHttpReadiness({
      signal: params.signal,
      timeoutMs: params.timeoutMs,
      url,
      workerVersion: params.workerVersion,
    });
    if (!readiness.ok) return readiness;
  }

  return { ok: true as const };
}

function resolvePreviewReadinessUrls(params: {
  projectHostnameBases?: readonly string[];
  publicUrl: string;
  readyUrlPath?: string;
}) {
  // Project hostname bases are routed by app data and wildcard DNS, so a
  // synthetic host like project.<base> is not a reliable app-health signal.
  return [new URL(params.readyUrlPath ?? defaultPreviewReadyUrlPath, params.publicUrl)];
}

const workerVersionReadinessHeader = "x-iterate-worker-version";
const deployedWorkerVersionPattern =
  /Current Version ID:\s*([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})/gi;

/**
 * Wrangler prints one version id per uploaded Worker. The OS deploy uploads
 * its sidecars first and the main Worker last, so the final id is the one its
 * public readiness route must report.
 */
function parseLastDeployedWorkerVersionId(output: string): string | null {
  return [...stripAnsi(output).matchAll(deployedWorkerVersionPattern)].at(-1)?.[1] ?? null;
}

async function waitForHttpReadiness(params: {
  signal?: AbortSignal;
  timeoutMs: number;
  url: URL;
  workerVersion?: { expected: string };
}) {
  const deadline = Date.now() + params.timeoutMs;
  let lastFailure = "No response received yet.";

  while (Date.now() < deadline) {
    try {
      const response = await fetchReadinessResponse(params.url, {
        signal: params.signal,
        timeoutMs: Math.max(1, Math.min(previewReadinessRequestTimeoutMs, deadline - Date.now())),
      });
      if (response.status >= 200 && response.status < 300) {
        params.signal?.throwIfAborted();
        if (Date.now() >= deadline) break;
        if (!params.workerVersion || response.workerVersion === params.workerVersion.expected) {
          return { ok: true as const };
        }

        lastFailure =
          `Readiness check reported Worker version ${response.workerVersion ?? "<missing>"}; ` +
          `expected ${params.workerVersion.expected}.`;
      } else {
        lastFailure =
          `Readiness check returned ${response.status} for ${params.url.toString()}` +
          formatReadinessResponseDetail(response);
      }
    } catch (error) {
      lastFailure = formatPreviewErrorMessage(error);
    }

    await sleep(Math.min(1_000, Math.max(0, deadline - Date.now())), params.signal);
  }

  return {
    message: `Timed out waiting for preview readiness at ${params.url.toString()}. ${lastFailure}`,
    ok: false as const,
  };
}

async function fetchReadinessResponse(
  url: URL,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<ReadinessResponse> {
  const requestTimeoutSignal = AbortSignal.timeout(
    Math.max(1, options.timeoutMs ?? previewReadinessRequestTimeoutMs),
  );
  const requestSignal = options.signal
    ? AbortSignal.any([options.signal, requestTimeoutSignal])
    : requestTimeoutSignal;
  try {
    const response = await fetch(url, {
      cache: "no-store",
      method: "GET",
      redirect: "follow",
      signal: requestSignal,
    });
    return {
      body: await readBoundedResponseBody(response),
      status: response.status,
      workerVersion: response.headers.get(workerVersionReadinessHeader),
    };
  } catch (error) {
    if (!isDnsLookupError(error)) {
      throw error;
    }

    return await requestReadinessWithDnsResolve({ signal: requestSignal, url });
  }
}

type ReadinessResponse = {
  body: string;
  status: number;
  workerVersion: string | null;
};

const readinessResponseBodyLimit = 4_096;

async function readBoundedResponseBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let truncated = false;
  while (bytesRead < readinessResponseBodyLimit) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = readinessResponseBodyLimit - bytesRead;
    chunks.push(value.subarray(0, remaining));
    bytesRead += Math.min(value.byteLength, remaining);
    if (value.byteLength > remaining) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }

  if (bytesRead >= readinessResponseBodyLimit && !truncated) {
    const { done } = await reader.read();
    truncated = !done;
    if (truncated) await reader.cancel();
  }
  const body = new TextDecoder().decode(concatenateBytes(chunks, bytesRead));
  return truncated ? `${body}…` : body;
}

function concatenateBytes(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function formatReadinessResponseDetail(response: ReadinessResponse): string {
  const detail = response.body.trim().replace(/\s+/g, " ");
  return detail ? `: ${detail}` : "";
}

async function requestReadinessWithDnsResolve(input: { signal?: AbortSignal; url: URL }) {
  const { signal, url } = input;
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported readiness URL protocol: ${url.protocol}`);
  }

  const addresses = await awaitWithAbort(dns.resolve4(url.hostname), signal);
  const address = addresses[0];
  if (!address) {
    throw new Error(`No A record found for ${url.hostname}`);
  }

  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  const resolvedUrl = new URL(url);
  resolvedUrl.hostname = address;

  return await new Promise<ReadinessResponse>((resolve, reject) => {
    const headers: Record<string, string> = { Host: url.host };
    const req = request(
      resolvedUrl,
      {
        headers,
        method: "GET",
        servername: url.hostname,
        signal,
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        const rawWorkerVersion = response.headers[workerVersionReadinessHeader];
        const workerVersion = Array.isArray(rawWorkerVersion)
          ? (rawWorkerVersion[0] ?? null)
          : (rawWorkerVersion ?? null);
        let body = "";
        let truncated = false;
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          const remaining = readinessResponseBodyLimit - body.length;
          if (remaining > 0) body += chunk.slice(0, remaining);
          if (chunk.length > remaining) truncated = true;
        });
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            body: truncated ? `${body}…` : body,
            status: statusCode,
            workerVersion,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await promise;
  signal.throwIfAborted();

  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new Error("Aborted"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function isDnsLookupError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const cause = "cause" in error ? error.cause : null;
  return (
    ("code" in error && error.code === "ENOTFOUND") ||
    (cause instanceof Error && "code" in cause && cause.code === "ENOTFOUND")
  );
}

async function resolvePullRequestPreviewContext(params: {
  commandEnvironment: NodeJS.ProcessEnv;
  githubToken: string;
  pullRequestNumber: number;
}): Promise<PullRequestPreviewContext> {
  const repositoryFullName =
    params.commandEnvironment.GITHUB_REPOSITORY?.trim() || defaultRepositoryFullName;
  const octokit = new Octokit({ auth: params.githubToken });
  const [owner, repo] = splitRepositoryFullName(repositoryFullName);
  const pullRequest = await withGithubRetry("pulls.get (context)", () =>
    octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: params.pullRequestNumber,
    }),
  );

  return {
    githubToken: params.githubToken,
    pullRequestBaseSha: pullRequest.data.base.sha,
    pullRequestBody: pullRequest.data.body || "",
    pullRequestHeadSha: pullRequest.data.head.sha,
    pullRequestHeadRef: pullRequest.data.head.ref,
    pullRequestIsDraft: pullRequest.data.draft === true,
    pullRequestLabels: pullRequest.data.labels.map((label) => label.name),
    pullRequestNumber: params.pullRequestNumber,
    repositoryFullName,
    workflowRunUrl:
      makeDefaultWorkflowRunUrl(params.commandEnvironment) || pullRequest.data.html_url || null,
  };
}

function resolvePreviewCompareBaseSha(params: {
  previousState: CloudflarePreviewState;
  pullRequestBaseSha: string;
}) {
  const previousHeadSha = Object.values(params.previousState.apps)
    .map((entry) => entry.headSha)
    .find((headSha): headSha is string => typeof headSha === "string" && headSha.length > 0);
  return previousHeadSha ?? params.pullRequestBaseSha;
}

export const previewInternals = {
  ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
  acquireAnyEnvironmentConfigLease,
  announceRetryTelemetry,
  renewRecordedEnvironmentConfigLease,
  assignEnvironmentConfigLease,
  claimEnvironmentConfigLease,
  classifyEnvironmentConfigLeases,
  classifyLeaseForReclaim,
  decideDraftPreviewPolicy,
  describeEnvironmentConfigLeases,
  describeForcePushCompareHazard,
  describeLostSlotOwnership,
  describePreviewSlotChange,
  diagnosePreviewFleetCapacity,
  evaluateCloudflareZoneCheck,
  holderPullRequestUrl,
  pullRequestHolder,
  pullRequestWouldClaimPreviewSlot,
  requireExplicitReclaimForce,
  takeAndCleanRecordedSlotIfFree,
  resolveSlotWaitTotalMs,
  selectPreviewEnvironmentsForGc,
  expandPreviewDependencies,
  orderPreviewDeployBatches,
  parseLastDeployedWorkerVersionId,
  parseCloudflarePreviewState,
  parseEnvironmentConfigLeaseData,
  previewProvisionedIntegrationSecrets,
  readPlaywrightTestTelemetry,
  readPreviewAppConfig,
  readCanonicalTestTelemetry,
  reconcileEnvironmentConfigLeaseResources,
  releaseLeaseDespiteTeardownFailure,
  renderCloudflarePreviewPullRequestBody,
  renderPreviewRetrySummary,
  previewTestFailureMessage,
  resolveAuthPreviewRootSecret,
  resolveSharedPreviewRootSecret,
  resolveProvisionAuthPreviewSlotNumbers,
  resolveRequestedPreviewEnvironment,
  resolvePreviewCompareBaseSha,
  resolvePreviewOsContainerRollout,
  resolvePreviewReadinessUrls,
  resolvePreviewTestBaseUrlEnvironment,
  resolvePreviewRolloutReadyAtMs,
  resolvePreviewRolloutRemainingSeconds,
  resolvePreviewTestTargetPlan,
  resolvePreviewTestTelemetryEnvironment,
  resolvePreviewTestWorkerVersionOverrides,
  selectPreviewAppsForPullRequest,
  selectPreviewAppsNeedingRetry,
  selectPreviewAppsForTesting,
  splitRepositoryFullName,
  syncPreviewInventory,
  withLeaseFence,
  waitForHttpReadiness,
};

function matchesPreviewPath(filename: string, patterns: readonly string[]) {
  return patterns.some((pattern) => {
    if (pattern.endsWith("/**")) {
      return filename.startsWith(pattern.slice(0, -2));
    }

    return filename === pattern;
  });
}

async function updatePreviewState(
  context: PullRequestPreviewContext,
  update: (state: CloudflarePreviewState) => CloudflarePreviewState,
) {
  return await updateCloudflarePreviewState({
    ...context,
    update,
  });
}

function canRunPreviewTests(entry: z.infer<typeof CloudflarePreviewAppEntry> | undefined) {
  return Boolean(
    entry?.publicUrl && ["awaiting-tests", "deployed", "tests-failed"].includes(entry.status),
  );
}

async function sleep(ms: number, signal?: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onDone = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(signal?.reason ?? new Error("Aborted"));
    };
    timeout = setTimeout(onDone, ms);
    if (!signal) {
      return;
    }

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Retry a GitHub REST call through transient failures. GitHub's API
 * intermittently returns 5xx/429/408 — its "Unicorn!" 503 page failed a
 * preview `test` step mid-flight fetching the PR (2026-07-02) — and without a
 * retry a single blip fails the whole deploy+e2e and costs a full re-run.
 * Only transient statuses retry with exponential backoff; deterministic 4xx
 * (404, 422, …) throw immediately.
 */
async function withGithubRetry<T>(
  label: string,
  call: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 1_000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await call();
    } catch (error) {
      const status = (error as { status?: number } | null)?.status;
      const transient = status != null && (status >= 500 || status === 429 || status === 408);
      lastError = error;
      if (!transient || attempt === attempts) throw error;
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      console.error(
        `[preview] GitHub ${label} failed with ${status} (attempt ${attempt}/${attempts}); retrying in ${delayMs}ms...`,
      );
      await sleep(delayMs, opts.signal);
    }
  }
  throw lastError;
}

function commandFailureMessage(
  result: {
    stderr?: string;
    stdout?: string;
  },
  fallback: string,
) {
  const text = sanitizePreviewOutput(
    [result.stderr, result.stdout]
      .filter((value) => typeof value === "string" && value.trim().length > 0)
      .join("\n")
      .trim(),
  );
  if (!text) {
    return fallback;
  }

  const maxLength = 4_000;
  if (text.length <= maxLength) {
    return text;
  }

  return `...(truncated)\n${text.slice(-maxLength)}`;
}

function makeDefaultWorkflowRunUrl(env: NodeJS.ProcessEnv) {
  if (!env.GITHUB_SERVER_URL || !env.GITHUB_REPOSITORY || !env.GITHUB_RUN_ID) {
    return undefined;
  }

  return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined || value === "") {
    throw new Error(message);
  }

  return value;
}

function formatPreviewErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function sanitizePreviewOutput(value: string) {
  const text = stripAnsi(value);
  const lines = text.split("\n");
  const sanitizedLines = lines.map((line) => {
    if (/^DOPPLER_TOKEN=/i.test(line)) {
      return "DOPPLER_TOKEN=[redacted]";
    }

    return line;
  });

  return sanitizedLines.join("\n");
}
