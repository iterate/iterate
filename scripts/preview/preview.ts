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
import {
  deploymentReadinessProbeQueryParam,
  deploymentReadinessProbeWaveCount,
} from "../../apps/os/src/deployment-readiness.ts";
import { createSemaphoreClient } from "../../apps/semaphore/src/contract.ts";
import {
  authEnvs,
  dummyPetshopEnvs,
  envs,
  previewEnvironmentSlotNumbers,
  semaphoreEnvs,
  streamsExampleEnvs,
} from "../../envs.ts";
import { createSemaphoreTokenProvider } from "../auth/semaphore-token.ts";
import { markdownAnnotator } from "../../packages/shared/src/dev/markdown-annotator.ts";
import { stripAnsi } from "../../packages/shared/src/dev/strip-ansi.ts";
import { runCommand } from "../../packages/shared/src/node/run-command.ts";
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
import {
  parseWorkerSizeFromDeployOutput,
  parseWorkerSizeStatusDescription,
  renderWorkerSizeCell,
  workerSizeStatusContext,
  type WorkerSizeInfo,
} from "./worker-size.ts";
import {
  normalizeError,
  PreviewE2ePostHog,
  type PreviewE2eModuleRecord,
  type PreviewE2eTestRecord,
} from "./e2e-posthog.ts";

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
   * redeploys apps affected since their LAST DEPLOYED head, so unaffected
   * apps keep an older recorded head and the test lane leaves them out of
   * its testable set (stale — deploy has not run for the current head). A
   * caller that needs the whole fleet testable at the current head — the
   * flake-hunt marathon preflight — uses this to reunify the fleet
   * explicitly instead of relying on the commit happening to touch a
   * fleet-shared path.
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
  return await deployPreviewApps({ context, options, runtime });
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
 * preview. This renews the existing lease but never deploys, erases data, or
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
  const environmentConfigLease =
    (await adoptLeaseHeldBySemaphore({
      holder,
      leaseMs: defaultPreviewLeaseMs,
      preferSlug: displaySlot?.slug ?? null,
      semaphore,
    })) ??
    (await retakeRecordedSlotIfFree({
      holder,
      leaseMs: defaultPreviewLeaseMs,
      recordedSlug: displaySlot?.slug ?? null,
      semaphore,
    }));
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
    headSha: context.pullRequestHeadSha,
  });
  // Match the full preview lane: RPC-only dependencies such as auth need an
  // exact version pin even though they do not contribute a public base URL.
  const versionedAppSlugs = expandPreviewDependencies([app.slug]);
  const workerVersionOverrides = resolvePreviewTestWorkerVersionOverrides({
    apps: recorded.apps,
    appSlugs: versionedAppSlugs,
    dopplerConfig: environmentConfigLease.dopplerConfig,
    headSha: context.pullRequestHeadSha,
  });
  const plan = resolvePreviewTestTargetPlan({
    ...selection,
    repositoryRoot: runtime.repositoryRoot,
  });
  await mkdir(dirname(plan.telemetryFile), { recursive: true });

  let passed = 0;
  let retries = 0;
  const failures: string[] = [];
  for (let iteration = 1; iteration <= selection.repeat; iteration += 1) {
    await rm(plan.telemetryFile, { force: true });
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
        `E2E_RETRY_TELEMETRY_FILE=${plan.telemetryFile}`,
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
      selection.runner === "vitest"
        ? readVitestTestTelemetry(plan.telemetryFile, "targeted vitest", runtime.repositoryRoot)
        : readPlaywrightTestTelemetry(
            plan.telemetryFile,
            "targeted playwright",
            runtime.repositoryRoot,
          ),
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
    `target tests finished: ${passed}/${selection.repeat} passed, ${failures.length} failed, ${retries} retries; deployment was reused without deploy or erase`,
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
 * structurally gone. The lease is shared through the semaphore itself (same
 * holder; test's adopt re-issues the slot deploy just claimed), never
 * through a handed-around copy. A deploy failure throws before any test
 * runs; a draft skip skips both phases.
 */
export async function run(options: DeployCommandOptions = {}) {
  const { context, runtime } = await resolvePreviewCommandSetup(options);
  const deployResult = await deployPreviewApps({ context, options, runtime });
  if ("skippedReason" in deployResult && deployResult.skippedReason === "draft") {
    return deployResult;
  }

  // A "nothing to deploy" skip still tests: the recorded deployments ARE the
  // current head's code, and their green must be earned, not assumed.
  return await withPreviewE2eTelemetry(context, runtime, "run", (telemetry) =>
    testPreviewApps({ context, runtime, state: deployResult.state, telemetry }),
  );
}

async function withPreviewE2eTelemetry<T>(
  context: PullRequestPreviewContext,
  runtime: PreviewRuntime,
  operation: "test" | "run",
  execute: (telemetry: PreviewE2ePostHog) => Promise<T>,
): Promise<T> {
  const telemetry = new PreviewE2ePostHog({
    environment: runtime.commandEnvironment,
    headSha: context.pullRequestHeadSha,
    operation,
    pullRequestNumber: context.pullRequestNumber,
    runUrl: context.workflowRunUrl,
  });
  const startedAt = Date.now();
  telemetry.runStarted();
  let result!: T;
  let operationError: unknown;
  try {
    result = await execute(telemetry);
  } catch (error) {
    operationError = error;
  }
  telemetry.runFinished({
    status: operationError ? "failed" : "passed",
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
      "Preview test command and PostHog delivery both failed",
    );
  }
  if (operationError) throw operationError;
  if (telemetryError) throw telemetryError;
  return result;
}

async function deployPreviewApps({
  context,
  options,
  runtime,
}: {
  context: PullRequestPreviewContext;
  options: DeployCommandOptions;
  runtime: PreviewRuntime;
}) {
  logPreview(
    `deploy for PR #${context.pullRequestNumber} (head ${context.pullRequestHeadSha.slice(0, 7)}) — holder ${pullRequestHolder(context.pullRequestNumber)}, semaphore ${defaultSemaphoreBaseUrl}`,
  );

  const current = await readCloudflarePreviewState(context);
  logPreview(
    current.state.environmentConfigLease
      ? `PR body shows slot ${current.state.environmentConfigLease.slug} (doppler config ${current.state.environmentConfigLease.dopplerConfig}) — display only; the semaphore decides ownership`
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

  let environmentConfigLease: EnvironmentConfigLease;
  try {
    const recordedSlug = current.state.environmentConfigLease?.slug ?? null;
    environmentConfigLease = requestedEnvironment
      ? (
          await assignEnvironmentConfigLease({
            eraseSlotData: makePreviewSlotDataEraser(runtime),
            holder,
            leaseMs: defaultPreviewLeaseMs,
            recordedSlug,
            semaphore,
            wantedSlug: requestedEnvironment,
          })
        ).lease
      : await claimEnvironmentConfigLease({
          eraseSlotData: makePreviewSlotDataEraser(runtime),
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
          recordedSlug,
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
  // A slot move invalidates every previously recorded deployment, not just
  // the diff-selected apps: anything left undeployed would keep old-slot URLs
  // and e2e would run against another slot's deployment.
  const previousSlug = current.state.environmentConfigLease?.slug ?? null;
  const appsToDeploy =
    previousSlug && previousSlug !== environmentConfigLease.slug
      ? expandPreviewDependencies([
          ...new Set([
            ...selectedApps.map((app) => app.slug),
            ...Object.keys(current.state.apps).filter(
              (appSlug): appSlug is CloudflarePreviewAppSlugType =>
                cloudflarePreviewApps[appSlug as CloudflarePreviewAppSlugType] != null,
            ),
          ]),
        ]).map((appSlug) => cloudflarePreviewApps[appSlug])
      : selectedApps;
  if (appsToDeploy.length > selectedApps.length) {
    logPreview(
      `slot changed from ${previousSlug} to ${environmentConfigLease.slug}: redeploying every previously recorded app (${appsToDeploy.map((app) => app.slug).join(", ")}) so nothing keeps pointing at the old slot`,
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
    environmentConfigLease: toSlotDisplay(environmentConfigLease),
    notice: claimNotice,
  }));

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
    const entries = await mapWithConcurrency(
      batch,
      defaultPreviewDeployConcurrency,
      async (app) => {
        return await deployPreviewAppWithStatus({
          app,
          existingEntry: current.state.apps[app.slug] ?? null,
          commandEnvironment: {
            ...runtime.commandEnvironment,
            // apps/os/scripts/deploy.ts turns this into
            // APP_CONFIG_ITERATE_SDK_PACKAGE_SPEC so project seeds and dynamic
            // builds install this head's pkg.pr.new `iterate` build, not @main.
            // The sha, not @<pr>: pkg.pr.new PR refs are moving
            // targets, while the sha pins the exact build this deploy shipped.
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
      },
    );
    if (entries.some((entry) => entry.status === "deploy-failed")) {
      ok = false;
    }

    for (const entry of entries) {
      accumulatedEntries[entry.appSlug] = entry;
    }
    const update = await updatePreviewState(context, (state) => ({
      ...state,
      environmentConfigLease: toSlotDisplay(environmentConfigLease),
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
  headSha,
}: {
  app: CloudflarePreviewApp;
  apps: Partial<
    Record<CloudflarePreviewAppSlug, { headSha?: string | null; publicUrl?: string | null }>
  >;
  headSha: string;
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

  return [...requiredUrls].map(([appSlug, environmentVariable]) => {
    const entry = apps[appSlug];
    if (!entry?.publicUrl || entry.headSha !== headSha) {
      throw new Error(
        `Cannot test ${app.slug}: ${environmentVariable} requires ${appSlug} deployed at head ${headSha.slice(0, 7)}. Re-run preview deploy.`,
      );
    }
    return `${environmentVariable}=${entry.publicUrl}`;
  });
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
      telemetryFile: resolve(input.repositoryRoot, "test-results/preview-target-vitest.json"),
      workingDirectory: resolve(input.repositoryRoot, "apps/os"),
    };
  }

  return {
    args: ["spec", target, ...(input.grep ? ["--grep", input.grep] : [])],
    command: "pnpm",
    telemetryFile: resolve(input.repositoryRoot, "test-results/playwright-results.json"),
    workingDirectory: input.repositoryRoot,
  };
}

function resolvePreviewTestWorkerVersionOverrides(input: {
  apps: Partial<Record<CloudflarePreviewAppSlug, CloudflarePreviewAppEntry>>;
  appSlugs: readonly CloudflarePreviewAppSlugType[];
  dopplerConfig: string;
  headSha: string;
}): string {
  return renderCloudflareWorkerVersionOverrides(
    input.appSlugs.map((appSlug) => {
      const entry = input.apps[appSlug];
      const expectedWorkerName = cloudflarePreviewApps[appSlug].resolvePreviewAppConfig(
        input.dopplerConfig,
      ).workerName;
      if (
        entry?.headSha !== input.headSha ||
        entry.deployedWorkerName !== expectedWorkerName ||
        !entry.deployedWorkerVersion
      ) {
        throw new Error(
          `Cannot test ${appSlug}: its exact ${expectedWorkerName} deployment identity is missing or stale for head ${input.headSha.slice(0, 7)}. Re-run preview deploy.`,
        );
      }
      return {
        versionId: entry.deployedWorkerVersion,
        workerName: entry.deployedWorkerName,
      };
    }),
  );
}

async function testPreviewApps({
  context,
  runtime,
  state: knownState,
  telemetry,
}: {
  context: PullRequestPreviewContext;
  runtime: PreviewRuntime;
  telemetry: PreviewE2ePostHog;
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

  // The semaphore is the single source of lease truth: resolve ownership
  // FIRST, from what the semaphore attributes to this holder right now. The
  // PR body's slot record is display only — it never authorizes tests and is
  // never a reason to skip them (a recorded copy once got nulled after a slot
  // steal, and the next run then skipped "no lease" instead of seeing the
  // steal).
  const holder = pullRequestHolder(context.pullRequestNumber);
  const semaphore = runtime.createPreviewSemaphoreResourceClient();
  const displaySlot = recorded.environmentConfigLease;
  const environmentConfigLease =
    (await adoptLeaseHeldBySemaphore({
      holder,
      leaseMs: defaultPreviewLeaseMs,
      preferSlug: displaySlot?.slug ?? null,
      semaphore,
    })) ??
    (await retakeRecordedSlotIfFree({
      holder,
      leaseMs: defaultPreviewLeaseMs,
      recordedSlug: displaySlot?.slug ?? null,
      semaphore,
    }));
  if (!environmentConfigLease) {
    const hasTestableRecordedApps = Object.values(recorded.apps).some((entry) =>
      canRunPreviewTests(entry),
    );
    if (!displaySlot && !hasTestableRecordedApps) {
      logPreview(
        `the semaphore leases no slot to ${holder} and nothing is deployed — skipping tests`,
      );
      return {
        ok: true,
        skipped: true,
        state: recorded,
      };
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
    // Display only: keep the recorded slot visible under the notice so a
    // human sees WHERE the takeover happened. Current-head apps are marked
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
  // Keep the human-facing display in step with reality. Never read back as
  // authority — the semaphore was just consulted above.
  if (
    displaySlot?.slug !== environmentConfigLease.slug ||
    displaySlot?.dopplerConfig !== environmentConfigLease.dopplerConfig
  ) {
    await updatePreviewState(context, (state) => ({
      ...state,
      environmentConfigLease: toSlotDisplay(environmentConfigLease),
    }));
  }

  const testableApps = Object.values(recorded.apps)
    .filter((entry) => canRunPreviewTests(entry) && entry.headSha === context.pullRequestHeadSha)
    .map((entry) => cloudflarePreviewApps[entry.appSlug as CloudflarePreviewAppSlugType])
    .filter((app): app is PreviewAppRuntime => app != null);

  if (testableApps.length === 0) {
    // Deploy leaves nothing recorded at this head only when nothing
    // app-affecting changed since the last fully tested deploy: its retry
    // selection redeploys every non-green recorded app at the current head
    // regardless of which head produced it (see
    // selectPreviewAppsNeedingRetry), so any app still at an older head is a
    // green whose results stand. `preview run` shares one resolved head
    // between the deploy and test phases, so the old two-step hazard — a
    // push racing into the gap and a green check describing a commit that
    // never ran — cannot reach this branch there. A standalone `test` just
    // reports the skip; the flake-hunt loop already treats any skip as "not
    // a green run".
    const notice = `Preview e2e skipped for head ${context.pullRequestHeadSha.slice(0, 7)}: no app is recorded at this head — nothing app-affecting changed since the last fully tested deploy, so the recorded results below still stand. If this PR has never deployed for this head, run preview deploy first.`;
    logPreview(notice);
    await updatePreviewState(context, (state) => ({
      ...state,
      notice,
    }));
    return {
      ok: true,
      skipped: true,
      skippedReason: "no-apps-at-current-head",
      state: recorded,
    };
  }
  logPreview(`testable apps: ${testableApps.map((app) => app.slug).join(", ")}`);
  const workerVersionOverrides = resolvePreviewTestWorkerVersionOverrides({
    apps: recorded.apps,
    appSlugs: testableApps.map((app) => app.slug),
    dopplerConfig: environmentConfigLease.dopplerConfig,
    headSha: context.pullRequestHeadSha,
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
      headSha: context.pullRequestHeadSha,
    });

    const startedAt = Date.now();
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
        ...baseUrlEnvironment,
        ...app.previewTestCommandArgs,
      ],
      command: "doppler",
      environment: runtime.commandEnvironment,
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
    for (const test of testSummary.tests) {
      telemetry.testFinished({ ...test, app: app.slug, slot: environmentConfigLease.slug });
    }
    for (const module of testSummary.modules) {
      telemetry.moduleFinished({ ...module, app: app.slug, slot: environmentConfigLease.slug });
    }

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
      testCount: testSummary.tests.length,
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
  // RELEASE failed, because a held lease leaks the slot for 24h and starves
  // the fleet. A failed teardown/erase alone exits zero with a loud warning:
  // the lease was released, the fleet is healthy, and the dirty slot
  // self-heals — every acquire erases on entry (eraseAcquiredSlotOrGiveItBack).
  if (!result.ok) {
    throw new Error(
      "Failed to release the preview slot lease — it leaks until its 24h expiry. Re-run cleanup, or free it with `pnpm preview release --slot <N> --force`.",
    );
  }
  if (result.teardownFailed) {
    logPreview(
      "cleanup exits 0 despite the failed teardown: the lease was released (fleet healthy) and the dirty slot is erased by its next acquire",
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
    eraseSlotData: makePreviewSlotDataEraser(runtime),
    force: options.force,
    holder,
    leaseMs: defaultPreviewLeaseMs,
    recordedSlug: current.state.environmentConfigLease?.slug ?? null,
    semaphore,
    wantedSlug,
  });

  // Anything but a kept/renewed lease breaks continuous ownership: even a
  // re-acquisition of the SAME slug means someone else may have deployed over
  // this PR's apps in the interim, so recorded deployments cannot be trusted.
  const needsRedeploy = result.outcome !== "kept";
  const redeployMessage = result.changedFromSlug
    ? `Slot reassigned from ${result.changedFromSlug} to ${result.lease.slug}; run preview deploy to redeploy here.`
    : `Slot ${result.lease.slug} was re-acquired after this PR's lease lapsed — previous deployments there may have been replaced. Run preview deploy to redeploy.`;
  const update = await updatePreviewState(context, (state) => ({
    ...state,
    environmentConfigLease: toSlotDisplay(result.lease),
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
 * Release a preview slot lease. Pass the lease id from `preview acquire`, or --force to release someone else's (stale) lease.
 * Does NOT erase the slot's data — that's safe, because every acquire erases
 * on entry. Use `preview reclaim --slot N` to take back AND wipe in one step.
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
    `reclaiming ${slug} from ${slot.holder ?? "unknown holder"} (${slot.verdict}${slot.lastUsedAgo ? `, last used ${slot.lastUsedAgo}` : ""}) — erasing its data before returning it to the pool`,
  );
  // Take the slot under OUR OWN fresh lease before erasing. The old holder's
  // lease could expire mid-erase (the verdict is a snapshot), and destroying
  // data on a slot another PR just acquired would wreck an innocent tenant —
  // a fresh lease parks the slot for the whole wipe. An erase failure leaves
  // that lease in place (parked and visible in this report) and throws
  // rather than returning a dirty slot to the pool.
  const holder = `reclaim-${userInfo().username}`;
  const taken = await semaphore.acquireSpecific({
    allowedSlugs: previewEnvironmentSlugs,
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
    slug,
    leaseMs: 30 * 60_000,
    holder,
    force: true,
  });
  if (!taken) {
    throw new Error(`Could not take ${slug} from ${slot.holder ?? "its holder"} — retry.`);
  }
  await makePreviewSlotDataEraser(runtime)({ dopplerConfig: slot.dopplerConfig, slug });
  const result = await semaphore.release({
    slug,
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
    leaseId: taken.leaseId,
  });
  return {
    released: result.released,
    erased: true,
    slug,
    reclaimedFrom: slot.holder,
    verdict: slot.verdict,
  };
}

/** A slot whose lease has passed its expiry — a GC sweep candidate. */
type ExpiredLeaseForGc = {
  slug: string;
  holder: string | null;
  dopplerConfig: string;
  leasedUntil: number;
};

/**
 * Pure selection for {@link gc}: the slots whose lease is leased but past its
 * expiry. Lease expiry is the sole GC signal — an expired lease means no live
 * tenant, so the whole slot is fair game (available slots are cleaned by their
 * next acquirer, not here). See docs/preview-resource-gc.md.
 */
function selectExpiredLeasesForGc(
  resources: ReadonlyArray<{
    data: Record<string, unknown>;
    holder?: string | null;
    leaseState: "available" | "leased";
    leasedUntil: number | null;
    slug: string;
  }>,
  now: number,
): ExpiredLeaseForGc[] {
  const expired: ExpiredLeaseForGc[] = [];
  for (const resource of resources) {
    if (resource.leaseState !== "leased" || resource.leasedUntil === null) continue;
    if (resource.leasedUntil > now) continue;
    expired.push({
      slug: resource.slug,
      holder: resource.holder ?? null,
      // Same fallback classifyEnvironmentConfigLeases uses: the slug-derived
      // config (preview-3 → preview_3) for a slot with no data payload yet.
      dopplerConfig:
        typeof resource.data.dopplerConfig === "string" && resource.data.dopplerConfig.trim()
          ? resource.data.dopplerConfig.trim()
          : resource.slug.replaceAll("-", "_"),
      leasedUntil: resource.leasedUntil,
    });
  }
  return expired;
}

/** Report what would be reclaimed without touching anything, or hold length. */
type GcOptions = {
  /** Print the plan without acquiring, erasing, or releasing anything. */
  dryRun?: boolean;
  /** Minutes to hold each slot while erasing it (default 30). */
  holdMinutes?: number;
};

/**
 * Garbage-collect preview slots whose lease has expired: for each, take it
 * under a fresh lease, erase its data, and release it — unattended and
 * rate-limited (runs sequentially). This is the lazy half of the model in
 * docs/preview-resource-gc.md: releasing a slot never waits on teardown, and
 * this scheduled sweep (the Cloudflare Preview GC Depot cron) reclaims whatever
 * the fast path — PR-close cleanup — did not.
 *
 * Lease expiry is the ONLY signal; the take is a NON-force acquire, which
 * succeeds only while the slot is genuinely free. So if a PR re-leased the slot
 * between our snapshot and the take, the acquire returns null and we skip it
 * (that PR's own erase-on-acquire cleans it) — no race, no verdict logic. An
 * erase failure still releases the slot: its next taker erases first, so a
 * half-wiped slot is self-healing and must not be parked out of the pool.
 */
export async function gc(options: GcOptions = {}) {
  const runtime = createPreviewRuntime();
  const semaphore = runtime.createPreviewSemaphoreResourceClient();
  const now = Date.now();
  const resources = await semaphore.list({ type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE });
  const expired = selectExpiredLeasesForGc(resources, now);
  const holdMs = (options.holdMinutes ?? 30) * 60_000;
  const eraseSlotData = makePreviewSlotDataEraser(runtime);

  const outcomes: Array<{
    slug: string;
    action: "reclaimed" | "skipped" | "erase-failed" | "would-reclaim";
    holder: string | null;
    error?: string;
  }> = [];
  for (const slot of expired) {
    if (options.dryRun) {
      outcomes.push({ slug: slot.slug, action: "would-reclaim", holder: slot.holder });
      continue;
    }
    const taken = await semaphore.acquireSpecific({
      allowedSlugs: previewEnvironmentSlugs,
      type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
      slug: slot.slug,
      leaseMs: holdMs,
      holder: "gc",
    });
    if (!taken) {
      logPreview(`gc: ${slot.slug} was re-leased since the snapshot — leaving it to its tenant`);
      outcomes.push({ slug: slot.slug, action: "skipped", holder: slot.holder });
      continue;
    }
    try {
      logPreview(
        `gc: reclaiming ${slot.slug} — lease from ${slot.holder ?? "unknown"} expired ${formatDurationMs(now - slot.leasedUntil)} ago; erasing`,
      );
      await eraseSlotData({ dopplerConfig: slot.dopplerConfig, slug: slot.slug });
      outcomes.push({ slug: slot.slug, action: "reclaimed", holder: slot.holder });
    } catch (error) {
      logPreview(
        `gc: erase failed for ${slot.slug}; releasing it for its next taker to re-erase: ${error instanceof Error ? error.message : String(error)}`,
      );
      outcomes.push({
        slug: slot.slug,
        action: "erase-failed",
        holder: slot.holder,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await semaphore.release({
        slug: slot.slug,
        type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
        leaseId: taken.leaseId,
      });
    }
  }

  const reclaimedCount = outcomes.filter((outcome) => outcome.action === "reclaimed").length;
  logPreview(
    `gc: ${expired.length} slot(s) past lease expiry, ${reclaimedCount} reclaimed${options.dryRun ? " (dry-run — nothing erased)" : ""}`,
  );
  return {
    checkedAt: new Date(now).toISOString(),
    leaseTtlHours: defaultPreviewLeaseMs / 3_600_000,
    dryRun: options.dryRun ?? false,
    expiredCount: expired.length,
    reclaimedCount,
    outcomes,
  };
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
  "semaphore",
  "auth",
  "streams-example-app",
  "dummy-petshop",
]);

export type CloudflarePreviewAppSlug = z.infer<typeof CloudflarePreviewAppSlug>;
type CloudflarePreviewAppSlugType = CloudflarePreviewAppSlug;

type PreviewReadyWorkerVersion =
  | {
      probeQueryParam?: undefined;
      probeWaveCount?: undefined;
      stableForMs: number;
    }
  | {
      probeQueryParam: string;
      probeWaveCount: number;
      stableForMs: number;
    };

export type CloudflarePreviewApp = {
  slug: CloudflarePreviewAppSlug;
  displayName: string;
  appPath: `apps/${string}`;
  /**
   * Run under `doppler run --project <p> --config preview_N --` in appPath;
   * every app exposes `deploy` (full deploy to the slot) and `destroy`
   * (release the slot's data — workers/routes/DNS always stay).
   */
  deployCommandArgs: readonly [string, ...string[]];
  destroyCommandArgs: readonly [string, ...string[]];
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
  /** Doppler env var sent as a bearer only to the app's active rollout probe. */
  previewReadyBearerTokenEnvVar?: string;
  /**
   * Require the readiness route to report wrangler's newly deployed Worker
   * version before tests start. Apps with Durable Objects expose a finite set
   * of probe waves: the orchestrator checks every wave in parallel, waits the
   * stability interval, then revalidates the complete set.
   */
  previewReadyWorkerVersion?: PreviewReadyWorkerVersion;
  previewTestBaseUrlEnvVar: string;
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
   * Collect every test/module result after the command finishes. A missing
   * report is an explicit collection error: a green lane must not silently
   * disappear from latency analytics.
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

/** Complete structured timing plus any lane that failed to produce a report. */
export type PreviewTestSummary = PreviewRetrySummary & {
  tests: PreviewE2eTestRecord[];
  modules: PreviewE2eModuleRecord[];
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
const authVitestTelemetryFile = "/tmp/auth-preview-vitest-results.json";
const semaphoreVitestTelemetryFile = "/tmp/semaphore-preview-vitest-results.json";
const dummyPetshopVitestTelemetryFile = "/tmp/dummy-petshop-preview-vitest-results.json";

/** Reads complete Vitest timing written by RetryTelemetryReporter. */
async function readVitestTestTelemetry(
  filePath: string,
  lane: string,
  repositoryRoot: string,
  framework: "vitest" | "node-test" | "script" = "vitest",
): Promise<PreviewTestSummary> {
  const TelemetryFile = z.object({
    tests: z.array(
      z.object({
        fullName: z.string(),
        moduleId: z.string(),
        retryCount: z.number().int().nonnegative(),
        passedAfterRetry: z.boolean(),
        state: z.string(),
        durationMs: z.number().nonnegative(),
        startedAtMs: z.number().optional(),
        scheduleDelayMs: z.number().nonnegative().optional(),
        beforeEachDurationMs: z.number().nonnegative(),
        afterEachDurationMs: z.number().nonnegative(),
        bodyDurationMs: z.number().nonnegative(),
        phases: z.array(
          z.object({
            name: z.string(),
            category: z.string().optional(),
            durationMs: z.number().nonnegative(),
          }),
        ),
        errors: z.array(
          z.object({
            message: z.string(),
            name: z.string().optional(),
            stack: z.string().optional(),
          }),
        ),
      }),
    ),
    modules: z.array(
      z.object({
        moduleId: z.string(),
        environmentSetupDurationMs: z.number().nonnegative(),
        prepareDurationMs: z.number().nonnegative(),
        collectDurationMs: z.number().nonnegative(),
        setupDurationMs: z.number().nonnegative(),
        testAndHookDurationMs: z.number().nonnegative(),
        importDurationMs: z.number().nonnegative(),
        queuedAtMs: z.number().optional(),
        collectedAtMs: z.number().optional(),
        startedAtMs: z.number().optional(),
        finishedAtMs: z.number().optional(),
        queueDurationMs: z.number().nonnegative().optional(),
        executionWallDurationMs: z.number().nonnegative().optional(),
      }),
    ),
    retried: z.array(
      z.object({
        fullName: z.string(),
        retryCount: z.number().int().positive(),
        passedAfterRetry: z.boolean(),
        firstFailure: z.string().optional(),
      }),
    ),
  });
  const parsed = TelemetryFile.parse(JSON.parse(await readFile(filePath, "utf8")));
  if (parsed.tests.length === 0) throw new Error(`${filePath} contained no test results`);
  const tests: PreviewE2eTestRecord[] = parsed.tests.map((record) => ({
    framework,
    lane,
    name: record.fullName,
    moduleId: normalizeTestModuleId(record.moduleId, repositoryRoot),
    state: record.state,
    durationMs: record.durationMs,
    retryCount: record.retryCount,
    passedAfterRetry: record.passedAfterRetry,
    ...(record.startedAtMs === undefined
      ? {}
      : { startedAt: new Date(record.startedAtMs).toISOString() }),
    ...(record.scheduleDelayMs === undefined ? {} : { scheduleDelayMs: record.scheduleDelayMs }),
    beforeEachDurationMs: record.beforeEachDurationMs,
    afterEachDurationMs: record.afterEachDurationMs,
    bodyDurationMs: record.bodyDurationMs,
    attempts: [],
    phases: record.phases,
    errors: record.errors,
  }));
  return {
    tests,
    modules: parsed.modules.map((record) => ({
      framework,
      lane,
      moduleId: normalizeTestModuleId(record.moduleId, repositoryRoot),
      environmentSetupDurationMs: record.environmentSetupDurationMs,
      prepareDurationMs: record.prepareDurationMs,
      collectDurationMs: record.collectDurationMs,
      setupDurationMs: record.setupDurationMs,
      testAndHookDurationMs: record.testAndHookDurationMs,
      importDurationMs: record.importDurationMs,
      ...(record.queuedAtMs === undefined
        ? {}
        : { queuedAt: new Date(record.queuedAtMs).toISOString() }),
      ...(record.collectedAtMs === undefined
        ? {}
        : { collectedAt: new Date(record.collectedAtMs).toISOString() }),
      ...(record.startedAtMs === undefined
        ? {}
        : { startedAt: new Date(record.startedAtMs).toISOString() }),
      ...(record.finishedAtMs === undefined
        ? {}
        : { finishedAt: new Date(record.finishedAtMs).toISOString() }),
      ...(record.queueDurationMs === undefined ? {} : { queueDurationMs: record.queueDurationMs }),
      ...(record.executionWallDurationMs === undefined
        ? {}
        : { executionWallDurationMs: record.executionWallDurationMs }),
    })),
    retried: parsed.retried.map((record) => ({
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
type PlaywrightTelemetryStep = {
  title?: string;
  category?: string;
  duration?: number;
  steps?: PlaywrightTelemetryStep[];
};

async function readPlaywrightTestTelemetry(
  filePath: string,
  lane: string,
  repositoryRoot: string,
): Promise<PreviewTestSummary> {
  /** The subset of Playwright's JSON-reporter suite tree we walk. */
  type PlaywrightJsonSuite = {
    title?: string;
    file?: string;
    suites?: PlaywrightJsonSuite[];
    specs?: {
      title?: string;
      file?: string;
      tests?: {
        projectName?: string;
        status?: string;
        results?: {
          retry?: number;
          status?: string;
          duration?: number;
          startTime?: string;
          workerIndex?: number;
          parallelIndex?: number;
          steps?: PlaywrightTelemetryStep[];
          error?: unknown;
          errors?: unknown[];
        }[];
      }[];
    }[];
  };
  const report = JSON.parse(await readFile(filePath, "utf8")) as {
    suites?: PlaywrightJsonSuite[];
  };
  const tests: PreviewE2eTestRecord[] = [];
  const visit = (suite: PlaywrightJsonSuite, parentTitles: string[] = []) => {
    const titles = suite.title ? [...parentTitles, suite.title] : parentTitles;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const retryCount = Math.max(0, ...(test.results ?? []).map((result) => result.retry ?? 0));
        const results = test.results ?? [];
        const finalResult = results.at(-1);
        const errors = results.flatMap((result) => [
          ...(result.error ? [normalizeError(result.error)] : []),
          ...(result.errors ?? []).map(normalizeError),
        ]);
        tests.push({
          framework: "playwright",
          lane,
          name: [...titles, spec.title ?? "(unknown spec)", test.projectName ?? ""]
            .filter(Boolean)
            .join(" › "),
          moduleId: normalizeTestModuleId(spec.file ?? suite.file ?? "playwright", repositoryRoot),
          ...(test.projectName ? { project: test.projectName } : {}),
          state: finalResult?.status ?? test.status ?? "unknown",
          durationMs: results.reduce((total, result) => total + (result.duration ?? 0), 0),
          retryCount,
          passedAfterRetry:
            retryCount > 0 && (test.status === "flaky" || finalResult?.status === "passed"),
          ...(results[0]?.startTime ? { startedAt: results[0].startTime } : {}),
          errors,
          phases: [],
          attempts: results.map((result) => ({
            attemptIndex: result.retry ?? 0,
            state: result.status ?? "unknown",
            durationMs: result.duration ?? 0,
            ...(result.startTime ? { startedAt: result.startTime } : {}),
            ...(result.workerIndex === undefined ? {} : { workerIndex: result.workerIndex }),
            ...(result.parallelIndex === undefined ? {} : { parallelIndex: result.parallelIndex }),
            ...(result.error ? { error: normalizeError(result.error) } : {}),
            phases: flattenPlaywrightSteps(result.steps ?? []),
          })),
        });
      }
    }
    for (const child of suite.suites ?? []) {
      visit(child, titles);
    }
  };
  for (const suite of report.suites ?? []) {
    visit(suite);
  }
  if (tests.length === 0) throw new Error(`${filePath} contained no test results`);
  return summaryFromTests(tests);
}

function flattenPlaywrightSteps(
  steps: ReadonlyArray<PlaywrightTelemetryStep>,
  parents: string[] = [],
): PreviewE2eTestRecord["phases"] {
  return steps.flatMap((step) => {
    const path = [...parents, step.title ?? "(unnamed step)"];
    return [
      {
        name: path.join(" › "),
        ...(step.category ? { category: step.category } : {}),
        durationMs: step.duration ?? 0,
      },
      ...flattenPlaywrightSteps(step.steps ?? [], path),
    ];
  });
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
    return { tests: [], modules: [], retried: [], collectionErrors: [message] };
  }
}

function summaryFromTests(tests: PreviewE2eTestRecord[]): PreviewTestSummary {
  return {
    tests,
    modules: [],
    retried: tests
      .filter((test) => test.retryCount > 0)
      .map((test) => ({
        lane: test.lane,
        name: test.name,
        retryCount: test.retryCount,
        passedAfterRetry: test.passedAfterRetry,
        ...(test.errors[0] ? { firstFailure: compactRetryFailure(test.errors[0]) } : {}),
      })),
    collectionErrors: [],
  };
}

function combineTestSummaries(summaries: PreviewTestSummary[]): PreviewTestSummary {
  return {
    tests: summaries.flatMap((summary) => summary.tests),
    modules: summaries.flatMap((summary) => summary.modules),
    retried: summaries.flatMap((summary) => summary.retried),
    collectionErrors: summaries.flatMap((summary) => summary.collectionErrors),
  };
}

function normalizeTestModuleId(moduleId: string, repositoryRoot: string): string {
  return moduleId.startsWith(repositoryRoot)
    ? moduleId.slice(repositoryRoot.length).replace(/^\//, "")
    : moduleId;
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
  const level = summary.retried.length >= 4 ? "warning" : "notice";
  console.log(
    `::${level} title=Preview e2e retries::${slug}: ${rendered}. The retry passed and does not fail ` +
      `this run; quarantine recurring or pathologically slow unrelated flakes per docs/testing.md.`,
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
  // Every app's generated wrangler config (routes, worker names, resource
  // IDs) derives from the root envs.ts — an envs.ts change (e.g. recreating a
  // slot's deleted D1) must redeploy the fleet or the fix never ships.
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

export const cloudflarePreviewApps: Record<CloudflarePreviewAppSlug, CloudflarePreviewApp> = {
  os: {
    slug: "os",
    displayName: "OS",
    appPath: "apps/os",
    deployCommandArgs: ["pnpm", "run-script", "deploy"],
    destroyCommandArgs: ["pnpm", "run-script", "destroy"],
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
    previewReadyBearerTokenEnvVar: "APP_CONFIG_ADMIN_API_SECRET",
    // Cloudflare rolls Durable Object namespaces independently from the edge.
    // Exercise every namespace's bounded placement waves, then revalidate the
    // exact version after a quiet interval before any project burst begins.
    previewReadyWorkerVersion: {
      probeQueryParam: deploymentReadinessProbeQueryParam,
      probeWaveCount: deploymentReadinessProbeWaveCount,
      stableForMs: 10_000,
    },
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
    // OS binds auth's RPC entrypoint, and its integration e2e uses dummy
    // Petshop. Co-select both; every deploy starts concurrently and OS derives
    // Auth's public signing key directly from Doppler.
    previewDependencies: ["auth", "dummy-petshop"],
    // Require wrangler's exact edge version to stay visible for a quiet
    // interval. Tests then pin that immutable version explicitly.
    previewDeployBudgetMs: 90_000,
    previewTestBudgetMs: 100_000,
    previewTestBaseUrlEnvVar: "APP_CONFIG_BASE_URL",
    previewTestDependencyBaseUrlEnvVars: {
      "dummy-petshop": "PETSHOP_BASE_URL",
    },
    // The apps/os e2e Vitest suite runs its `node` project (engine + itx
    // catalogue matrix; the `browser` project is skipped here — the root
    // Playwright REPL specs cover the catalogue in-browser). It reads
    // APP_CONFIG_BASE_URL + APP_CONFIG_ADMIN_API_SECRET from the leased
    // preview Doppler config. Root Playwright specs run alongside it, using
    // the same preview Doppler config.
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
        // let it overlap the smoke and the vitest lane; it's ready by the
        // time we reach the specs instead of adding ~4s in front of them.
        "pnpm --dir ../.. exec playwright install chromium > /tmp/os-preview-pw-install.log 2>&1 & PW_INSTALL_PID=$!",
        // Smoke, TUI, Vitest, and Playwright own isolated state, so start them
        // together. The examples matrix shares one project but marker-isolates
        // every mutable resource.
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
        `run_logged_lane smoke /tmp/os-preview-smoke.log env E2E_RETRY_TELEMETRY_FILE=${osOnboardingSmokeTelemetryFile} timeout ${OS_ONBOARDING_SMOKE_TIMEOUT_SECS} pnpm exec tsx e2e/vitest/onboarding-smoke.ts & SMOKE_PID=$!`,
        `run_logged_lane tui /tmp/os-preview-tui.log env E2E_RETRY_TELEMETRY_FILE=${osTuiRetryTelemetryFile} timeout ${OS_TUI_LANE_TIMEOUT_SECS} pnpm exec tsx e2e/tui-test/run.ts & TUI_PID=$!`,
        `run_logged_lane vitest /tmp/os-preview-vitest.log env E2E_RETRY_TELEMETRY_FILE=${osVitestRetryTelemetryFile} timeout ${OS_PREVIEW_LANE_TIMEOUT_SECS} pnpm e2e --project node & E2E_PID=$!`,
        'PW_INSTALL_OK=0; wait "$PW_INSTALL_PID" || PW_INSTALL_OK=$?',
        `if [ "$PW_INSTALL_OK" -eq 0 ]; then SPEC_OK=0; run_visible_lane playwright env PLAYWRIGHT_PREVIEW_SLOW_FIRST=1 timeout ${OS_PREVIEW_LANE_TIMEOUT_SECS} pnpm --dir ../.. spec || SPEC_OK=$?; else cat /tmp/os-preview-pw-install.log; SPEC_OK=$PW_INSTALL_OK; fi`,
        'E2E_OK=0; wait "$E2E_PID" || E2E_OK=$?',
        'TUI_OK=0; wait "$TUI_PID" || TUI_OK=$?',
        'SMOKE_OK=0; wait "$SMOKE_PID" || SMOKE_OK=$?',
        "cat /tmp/os-preview-smoke.log",
        "cat /tmp/os-preview-vitest.log",
        "cat /tmp/os-preview-tui.log",
        '[ "$SMOKE_OK" -eq 0 ] && [ "$E2E_OK" -eq 0 ] && [ "$TUI_OK" -eq 0 ] && [ "$SPEC_OK" -eq 0 ]',
      ].join("; "),
    ],
    collectTestTelemetry: async ({ repositoryRoot }) => {
      const [smoke, vitest, specs] = await Promise.all([
        readTestTelemetryLane("os onboarding smoke", () =>
          readVitestTestTelemetry(
            osOnboardingSmokeTelemetryFile,
            "onboarding smoke",
            repositoryRoot,
            "script",
          ),
        ),
        readTestTelemetryLane("os vitest lane", () =>
          readVitestTestTelemetry(osVitestRetryTelemetryFile, "vitest", repositoryRoot),
        ),
        readTestTelemetryLane("os playwright specs", () =>
          readPlaywrightTestTelemetry(
            resolve(repositoryRoot, "test-results/playwright-results.json"),
            "playwright",
            repositoryRoot,
          ),
        ),
      ]);
      // TUI is currently an explicit no-op skip and produces no test report.
      return combineTestSummaries([smoke, vitest, specs]);
    },
  },
  semaphore: {
    slug: "semaphore",
    displayName: "Semaphore",
    appPath: "apps/semaphore",
    deployCommandArgs: ["pnpm", "run-script", "deploy"],
    // Semaphore's preview e2e generates per-run-unique resource types and
    // self-cleans; there is nothing slot-scoped to erase on release.
    destroyCommandArgs: ["pnpm", "run-script", "destroy"],
    dopplerProject: "semaphore",
    resolvePreviewAppConfig: (dopplerConfig) => {
      const environment = requirePreviewEnvironment("semaphore", dopplerConfig, semaphoreEnvs);
      return { baseUrl: environment.baseUrl, workerName: environment.workerName };
    },
    paths: ["apps/semaphore/**"],
    // Co-select auth for an environment-coherent test run. Deploys are independent.
    previewDependencies: ["auth"],
    previewTestBaseUrlEnvVar: "SEMAPHORE_BASE_URL",
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
      `rm -f ${semaphoreVitestTelemetryFile}; env -u SEMAPHORE_API_TOKEN E2E_RETRY_TELEMETRY_FILE=${semaphoreVitestTelemetryFile} pnpm test:e2e`,
    ],
    collectTestTelemetry: async ({ repositoryRoot }) =>
      readTestTelemetryLane("semaphore vitest lane", () =>
        readVitestTestTelemetry(semaphoreVitestTelemetryFile, "vitest", repositoryRoot),
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
    destroyCommandArgs: ["pnpm", "run-script", "destroy"],
    dopplerProject: "auth",
    resolvePreviewAppConfig: (dopplerConfig) => {
      const environment = requirePreviewEnvironment("auth", dopplerConfig, authEnvs);
      return { baseUrl: environment.authBaseUrl, workerName: environment.authWorkerName };
    },
    paths: ["apps/auth/**", "apps/auth-contract/**"],
    // better-auth's liveness endpoint; auth has no /api/__internal/health.
    previewReadyUrlPath: "/api/auth/ok",
    previewTestBaseUrlEnvVar: "AUTH_BASE_URL",
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
      `rm -f ${authVitestTelemetryFile}; E2E_RETRY_TELEMETRY_FILE=${authVitestTelemetryFile} pnpm test:e2e`,
    ],
    collectTestTelemetry: async ({ repositoryRoot }) =>
      readTestTelemetryLane("auth vitest lane", () =>
        readVitestTestTelemetry(authVitestTelemetryFile, "vitest", repositoryRoot),
      ),
  },
  "streams-example-app": {
    slug: "streams-example-app",
    displayName: "Streams Example App",
    appPath: "apps/streams-example-app",
    deployCommandArgs: ["pnpm", "run-script", "deploy"],
    destroyCommandArgs: ["pnpm", "run-script", "destroy"],
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
    previewReadyBearerTokenEnvVar: "APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET",
    previewReadyWorkerVersion: {
      probeQueryParam: deploymentReadinessProbeQueryParam,
      probeWaveCount: deploymentReadinessProbeWaveCount,
      stableForMs: 10_000,
    },
    previewTestBaseUrlEnvVar: "WORKER_URL",
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
        `E2E_RETRY_TELEMETRY_FILE=${streamsExampleVitestRetryTelemetryFile} timeout ${OS_PREVIEW_LANE_TIMEOUT_SECS} pnpm vitest > /tmp/os-preview-streams-example-vitest.log 2>&1 & vitest_pid=$!`,
        'wait "$install_pid" || { cat /tmp/os-preview-streams-example-pw-install.log; exit 1; }',
        // Capture Playwright's exit without aborting (set -e) so the vitest
        // sub-lane always finishes and its log is replayed.
        `PW_OK=0; timeout ${OS_PREVIEW_LANE_TIMEOUT_SECS} pnpm playwright || PW_OK=$?`,
        'VITEST_OK=0; wait "$vitest_pid" || VITEST_OK=$?',
        "cat /tmp/os-preview-streams-example-vitest.log",
        '[ "$VITEST_OK" -eq 0 ] && [ "$PW_OK" -eq 0 ]',
      ].join("; "),
    ],
    collectTestTelemetry: async ({ repositoryRoot }) => {
      const [vitest, playwright] = await Promise.all([
        readTestTelemetryLane("streams-example-app vitest lane", () =>
          readVitestTestTelemetry(streamsExampleVitestRetryTelemetryFile, "vitest", repositoryRoot),
        ),
        readTestTelemetryLane("streams-example-app playwright lane", () =>
          readPlaywrightTestTelemetry(
            resolve(
              repositoryRoot,
              "apps/streams-example-app/test-results/playwright-results.json",
            ),
            "playwright",
            repositoryRoot,
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
    destroyCommandArgs: ["pnpm", "run-script", "destroy"],
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
    previewTestBaseUrlEnvVar: "PETSHOP_BASE_URL",
    previewTestCommandArgs: [
      "bash",
      "-c",
      `rm -f ${dummyPetshopVitestTelemetryFile}; E2E_RETRY_TELEMETRY_FILE=${dummyPetshopVitestTelemetryFile} pnpm test:e2e`,
    ],
    collectTestTelemetry: async ({ repositoryRoot }) =>
      readTestTelemetryLane("dummy-petshop vitest lane", () =>
        readVitestTestTelemetry(dummyPetshopVitestTelemetryFile, "vitest", repositoryRoot),
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

/**
 * A live lease as the semaphore issued it. Exists only in memory for the
 * duration of a command: the semaphore is the single source of lease truth,
 * so leases are never persisted or compared against a stored copy — every
 * command that needs one asks the semaphore afresh (see
 * adoptLeaseHeldBySemaphore).
 */
export type EnvironmentConfigLease = {
  dopplerConfig: string;
  leasedUntil: number;
  leaseId: string;
  slug: string;
  type: string;
};

/**
 * The PR body's record of which slot a PR's previews live on — DISPLAY ONLY.
 * It tells humans where to look (slot, doppler config) and lets deploy prefer
 * its previous slot; it is never lease authority and never a reason to skip
 * tests. Ownership questions always go to the semaphore.
 */
export const CloudflarePreviewSlotDisplay = z.object({
  dopplerConfig: z.string().trim().min(1),
  slug: z.string().trim().min(1),
});
export type CloudflarePreviewSlotDisplay = z.infer<typeof CloudflarePreviewSlotDisplay>;

function toSlotDisplay(lease: EnvironmentConfigLease): CloudflarePreviewSlotDisplay {
  return { dopplerConfig: lease.dopplerConfig, slug: lease.slug };
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
  headSha: z.string().trim().min(1).nullable().optional(),
  message: z.string().trim().min(1).nullable().optional(),
  publicUrl: z.string().trim().url().nullable().optional(),
  runUrl: z.string().trim().url().nullable().optional(),
  shortSha: z.string().trim().min(1).nullable().optional(),
  cleanupDurationMs: z.number().nonnegative().finite().nullable().optional(),
  deployDurationMs: z.number().nonnegative().finite().nullable().optional(),
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
  // Display only (see CloudflarePreviewSlotDisplay). Bodies written before
  // the semaphore became the single lease truth carry extra lease fields
  // (leaseId, leasedUntil, type); z.object strips them on parse.
  environmentConfigLease: CloudflarePreviewSlotDisplay.nullable().default(null),
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

export const environmentConfigLeaseInventory = previewEnvironmentSlotNumbers.map((leaseNumber) => {
  return {
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
    slug: `preview-${leaseNumber}`,
    data: {
      dopplerConfig: `preview_${leaseNumber}`,
    },
  };
}) satisfies EnvironmentConfigLeaseInventoryItem[];

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
  release: (input: { force?: boolean; leaseId?: string; slug: string; type: string }) => Promise<{
    released: boolean;
  }>;
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
  repositoryRoot: string;
  signal?: AbortSignal;
};

type PullRequestPreviewContext = {
  githubToken: string;
  pullRequestBaseSha: string;
  pullRequestBody: string;
  pullRequestHeadSha: string;
  pullRequestIsDraft: boolean;
  pullRequestLabels: string[];
  pullRequestNumber: number;
  repositoryFullName: string;
  workflowRunUrl: string | null;
};

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
    acquire: ({ allowedSlugs, holder, leaseMs, type, waitMs }) =>
      semaphore.resources.acquire({ allowedSlugs, holder, leaseMs, type, waitMs }),
    acquireSpecific: ({ allowedSlugs, force, holder, leaseMs, slug, type }) =>
      semaphore.resources.acquireSpecific({ allowedSlugs, force, holder, leaseMs, slug, type }),
    release: ({ force, leaseId, slug, type }) =>
      semaphore.resources.release({ force, leaseId, slug, type }),
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

async function ensureAuthPreviewConfigs(input: { rotate: boolean; slots: number[] }) {
  const authSigningPrivateJwk = getDopplerSecret("_shared", "preview", "AUTH_FORGE_PRIVATE_JWK");
  if (!authSigningPrivateJwk) {
    throw new Error("_shared/preview is missing AUTH_FORGE_PRIVATE_JWK");
  }

  // This is deliberately inherited, not copied: every app's preview
  // environment root inherits _shared/preview, giving key rotation one source
  // of truth. Fail closed if that topology has drifted instead of writing a
  // second app-local copy that could later shadow the shared key.
  for (const project of ["auth", "os", "semaphore", "streams-example-app"]) {
    const effectiveKey = getDopplerSecret(project, "preview", "AUTH_FORGE_PRIVATE_JWK");
    if (effectiveKey !== authSigningPrivateJwk) {
      throw new Error(
        `${project}/preview must inherit AUTH_FORGE_PRIVATE_JWK from _shared/preview`,
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
  setDopplerSecrets("auth", "preview", rootValues);
  console.log("auth/preview root config ensured");

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
  // Never destroy a slot this PR does not hold: ownership comes from the
  // semaphore (single source of lease truth), not from the PR body — which
  // also heals the case where a cancelled run claimed a slot but died before
  // recording it (the slot still gets torn down and released here).
  const holder = pullRequestHolder(params.context.pullRequestNumber);
  const semaphore = params.createPreviewSemaphoreResourceClient();
  const displaySlot = current.state.environmentConfigLease;
  const environmentConfigLease =
    (await adoptLeaseHeldBySemaphore({
      holder,
      leaseMs: defaultPreviewLeaseMs,
      preferSlug: displaySlot?.slug ?? null,
      semaphore,
    })) ??
    // A lapsed-but-free recorded slot still carries this PR's deployment;
    // take it back (non-force) so the teardown can erase it.
    (await retakeRecordedSlotIfFree({
      holder,
      leaseMs: defaultPreviewLeaseMs,
      recordedSlug: displaySlot?.slug ?? null,
      semaphore,
    }));
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

  let ok = true;
  let latestState = current.state;
  const appsToCleanUp = (Object.keys(current.state.apps) as CloudflarePreviewAppSlugType[])
    .map((appSlug) => cloudflarePreviewApps[appSlug])
    .filter((app): app is PreviewAppRuntime => app != null);
  const cleanupBatches = [...orderPreviewDeployBatches(appsToCleanUp)].reverse();
  // Same stale-read guard as deploy: keep every batch's entries in each write.
  const accumulatedEntries: Record<string, CloudflarePreviewAppEntry> = {};
  for (const batch of cleanupBatches) {
    const entries = await mapWithConcurrency(
      batch,
      defaultPreviewDeployConcurrency,
      async (app) => {
        const startedAt = Date.now();
        logPreview(
          `cleanup start: destroying ${app.slug} on ${environmentConfigLease.slug} (doppler config ${environmentConfigLease.dopplerConfig})`,
        );
        const destroyResult = await runPreviewDeployCommand({
          app,
          commandEnvironment: params.commandEnvironment,
          dopplerConfig: environmentConfigLease.dopplerConfig,
          operation: "down",
          repositoryRoot: params.repositoryRoot,
          signal: params.signal,
        });
        const cleanupDurationMs = Date.now() - startedAt;
        console.error(
          `[preview] cleanup ${destroyResult.exitCode === 0 ? "passed" : "failed"}: ${app.slug} (${formatDurationMs(cleanupDurationMs)})`,
        );
        const existingEntry = latestState.apps[app.slug];
        return CloudflarePreviewAppEntry.parse({
          ...existingEntry,
          appDisplayName: app.displayName,
          appSlug: app.slug,
          message:
            destroyResult.exitCode === 0
              ? "Preview app released."
              : commandFailureMessage(destroyResult, "Preview teardown failed."),
          cleanupDurationMs,
          status: destroyResult.exitCode === 0 ? "released" : "cleanup-failed",
          updatedAt: new Date().toISOString(),
        });
      },
    );
    if (entries.some((entry) => entry.status === "cleanup-failed")) {
      ok = false;
    }

    for (const entry of entries) {
      accumulatedEntries[entry.appSlug] = entry;
    }
    const update = await updatePreviewState(params.context, (state) => ({
      ...state,
      apps: {
        ...state.apps,
        ...accumulatedEntries,
      },
    }));
    latestState = update.state;
  }

  // Cleanup's contract: RELEASING THE LEASE is the load-bearing outcome, not
  // the teardown. A failed teardown/erase leaves only slot-local dirt, and
  // dirt is self-healing — every acquire erases the slot before handing it
  // out (see eraseAcquiredSlotOrGiveItBack) — but a lease that is never
  // released leaks until its 24h expiry and starves the 9-slot fleet
  // (2026-07-14: a Cloudflare API 429 failed erase-data mid-cleanup for the
  // merged pr-1950; the old code bailed before releasing and pr-1988 waited
  // 360s for a slot that never came). So: always release; `ok: false` now
  // means the RELEASE itself failed — the lease truly leaked.
  const releaseResult = await releaseLeaseDespiteTeardownFailure({
    lease: environmentConfigLease,
    semaphore,
    teardownOk: ok,
  });
  if (!releaseResult.ok) {
    // Keep the recorded lease in the PR body so a cleanup re-run still finds
    // the slot to release.
    return {
      ok: false,
      released: false,
      teardownFailed: !ok,
      state: latestState,
    };
  }
  const update = await updatePreviewState(params.context, (state) => ({
    ...state,
    environmentConfigLease: null,
    notice: ok
      ? state.notice
      : `Teardown failed but the lease was released; ${environmentConfigLease.slug} is left dirty and its next acquire erases it before use. (preview cleanup at ${new Date().toISOString()})`,
  }));

  return {
    ok: true,
    released: releaseResult.released,
    teardownFailed: !ok,
    state: update.state,
  };
}

/**
 * Release cleanup's lease whether or not teardown succeeded, loudly flagging
 * the dirty-slot case. Returns `ok: false` only when the release call itself
 * failed — that is the one outcome where the lease actually leaks (until its
 * 24h expiry); a teardown failure alone is not a leak because the next
 * acquire erases the slot on entry (eraseAcquiredSlotOrGiveItBack).
 */
async function releaseLeaseDespiteTeardownFailure(input: {
  lease: { type: string; slug: string; leaseId: string };
  semaphore: PreviewSemaphoreResourceClient;
  teardownOk: boolean;
}): Promise<{ ok: boolean; released: boolean }> {
  if (!input.teardownOk) {
    logPreview(
      `teardown FAILED on ${input.lease.slug} — releasing the lease anyway and leaving the slot dirty; its next acquire erases it before use (see eraseAcquiredSlotOrGiveItBack)`,
    );
  }
  try {
    const released = await input.semaphore.release({
      type: input.lease.type,
      slug: input.lease.slug,
      leaseId: input.lease.leaseId,
    });
    logPreview(
      released.released
        ? `lease released: ${input.lease.slug} is free again`
        : `lease was already gone for ${input.lease.slug}`,
    );
    return { ok: true, released: released.released };
  } catch (error) {
    logPreview(
      `FAILED to release the lease on ${input.lease.slug} — it leaks until its 24h expiry (free it with \`pnpm preview release --slot ${input.lease.slug} --force\` or re-run cleanup): ${error instanceof Error ? error.message : String(error)}`,
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
  const appConfig = await readPreviewAppConfig({
    app: input.app,
    commandEnvironment: input.commandEnvironment,
    dopplerConfig: input.dopplerConfig,
    repositoryRoot: input.repositoryRoot,
    signal: input.signal,
  });
  const baseEntry = {
    appDisplayName: input.app.displayName,
    appSlug: input.app.slug,
    headSha: input.pullRequestHeadSha,
    publicUrl: appConfig.baseUrl,
    runUrl: input.runUrl,
    shortSha: input.pullRequestHeadSha.slice(0, 7),
    updatedAt: new Date().toISOString(),
  } as const;

  const fingerprint = previewAppContentFingerprint(input.app, input.repositoryRoot);
  if (
    fingerprint !== null &&
    input.existingEntry?.status === "deployed" &&
    input.existingEntry.publicUrl === appConfig.baseUrl &&
    input.existingEntry.deployedFingerprint === fingerprint &&
    input.existingEntry.deployedWorkerName === appConfig.workerName &&
    input.existingEntry.deployedWorkerVersion &&
    // The record alone is not proof the worker still answers — this app may
    // be selected precisely because the not-serving sweep found it dead
    // (selectRecordedGreenAppsNotServing), e.g. after a slot erase. Skip only
    // when every readiness URL answers right now.
    (
      await Promise.all(
        resolvePreviewReadinessUrls({
          publicUrl: appConfig.baseUrl,
          readyUrlPath: input.app.previewReadyUrlPath,
        }).map((url) => probePreviewAppServingOnce(url)),
      )
    ).every((probe) => probe.ok)
  ) {
    // Same slot, same content, last run fully green, worker answering: what
    // is serving is byte-identical to what this deploy would upload. Skip
    // the wrangler/Cloudflare-API round trip; the e2e smoke still verifies it.
    logPreview(
      `deploy skipped: ${input.app.slug} unchanged since ${input.existingEntry.shortSha ?? "the recorded deploy"} on this slot and serving (fingerprint ${fingerprint.slice(0, 12)}…)`,
    );
    return CloudflarePreviewAppEntry.parse({
      ...baseEntry,
      deployedFingerprint: fingerprint,
      deployedWorkerName: input.existingEntry.deployedWorkerName,
      deployedWorkerVersion: input.existingEntry.deployedWorkerVersion,
      workerSizeKib: input.existingEntry.workerSizeKib ?? null,
      workerGzipKib: input.existingEntry.workerGzipKib ?? null,
      mainWorkerGzipKib: input.existingEntry.mainWorkerGzipKib ?? null,
      status: "awaiting-tests",
    });
  }

  const deployResult = await runPreviewDeployCommand({
    app: input.app,
    commandEnvironment: input.commandEnvironment,
    dopplerConfig: input.dopplerConfig,
    operation: "up",
    repositoryRoot: input.repositoryRoot,
    signal: input.signal,
  });
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
      message: commandFailureMessage(deployResult, "Preview deployment failed."),
      status: "deploy-failed",
    });
  }

  const deployedWorkerVersion = parseLastDeployedWorkerVersionId(
    `${deployResult.stdout}\n${deployResult.stderr}`,
  );
  if (!deployedWorkerVersion) {
    return CloudflarePreviewAppEntry.parse({
      ...baseEntry,
      ...sizeFields,
      message:
        "Preview deployment succeeded, but wrangler did not report the exact Worker version required by preview tests.",
      status: "deploy-failed",
    });
  }

  const readiness = await waitForPreviewAppReadiness({
    publicUrl: appConfig.baseUrl,
    readyUrlPath: input.app.previewReadyUrlPath,
    readinessBearerToken: appConfig.readinessBearerToken,
    signal: input.signal,
    timeoutMs: defaultPreviewReadyTimeoutMs,
    workerVersion:
      deployedWorkerVersion && input.app.previewReadyWorkerVersion
        ? {
            expected: deployedWorkerVersion,
            ...input.app.previewReadyWorkerVersion,
          }
        : undefined,
  });
  if (!readiness.ok) {
    return CloudflarePreviewAppEntry.parse({
      ...baseEntry,
      ...sizeFields,
      message: readiness.message,
      status: "deploy-failed",
    });
  }

  return CloudflarePreviewAppEntry.parse({
    ...baseEntry,
    ...sizeFields,
    deployedWorkerName: appConfig.workerName,
    deployedWorkerVersion,
    deployedFingerprint: fingerprint,
    status: "awaiting-tests",
  });
}

async function readPreviewAppConfig(input: {
  app: PreviewAppRuntime;
  commandEnvironment: NodeJS.ProcessEnv;
  dopplerConfig: string;
  repositoryRoot: string;
  signal?: AbortSignal;
}) {
  const PreviewAppConfig = z.object({
    baseUrl: z.string().trim().url(),
    projectHostnameBases: z.array(z.string().trim().min(1)).default([]),
    readinessBearerToken: z.string().trim().min(1).optional(),
    workerName: z.string().trim().min(1),
  });
  const parsePreviewAppConfig = (value: unknown) => {
    const parsed = PreviewAppConfig.parse(value);
    if (input.app.previewReadyBearerTokenEnvVar && !parsed.readinessBearerToken) {
      throw new Error(
        `Preview readiness requires Doppler secret ${input.app.previewReadyBearerTokenEnvVar}.`,
      );
    }
    return parsed;
  };
  const repoConfig = input.app.resolvePreviewAppConfig(input.dopplerConfig);
  if (!input.app.previewReadyBearerTokenEnvVar) {
    return parsePreviewAppConfig(repoConfig);
  }

  const readinessBearerTokenEnvVar = JSON.stringify(
    input.app.previewReadyBearerTokenEnvVar ?? null,
  );
  const script = [
    "function parseStringArrayEnv(value) {",
    "  if (!value?.trim()) return [];",
    "  const parsed = JSON.parse(value);",
    "  return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : [];",
    "}",
    "function parseAppConfig() {",
    "  if (!process.env.APP_CONFIG?.trim()) return {};",
    "  return JSON.parse(process.env.APP_CONFIG);",
    "}",
    "const appConfig = parseAppConfig();",
    "const envBases = parseStringArrayEnv(process.env.APP_CONFIG_PROJECT_HOSTNAME_BASES);",
    `const readinessBearerTokenEnvVar = ${readinessBearerTokenEnvVar};`,
    "const readinessBearerToken = readinessBearerTokenEnvVar ? process.env[readinessBearerTokenEnvVar]?.trim() : undefined;",
    "const config = {",
    "  baseUrl: process.env.APP_CONFIG_BASE_URL || appConfig.baseUrl || null,",
    "  projectHostnameBases: envBases.length > 0 ? envBases : Array.isArray(appConfig.projectHostnameBases) ? appConfig.projectHostnameBases.filter((entry) => typeof entry === 'string') : [],",
    "  ...(readinessBearerToken ? { readinessBearerToken } : {}),",
    "};",
    "console.log(JSON.stringify(config));",
  ].join("\n");
  const result = await runCommand({
    args: [
      "run",
      "--project",
      input.app.dopplerProject,
      "--config",
      input.dopplerConfig,
      "--",
      "node",
      "-e",
      script,
    ],
    command: "doppler",
    echoOutput: false,
    environment: input.commandEnvironment,
    signal: input.signal,
    workingDirectory: resolve(input.repositoryRoot, input.app.appPath),
  });
  if (result.exitCode !== 0) {
    // stdout may contain the readiness bearer; never include command output.
    throw new Error("Failed to read preview app config.");
  }

  const dopplerConfig: unknown = JSON.parse(result.stdout);
  return parsePreviewAppConfig(
    typeof dopplerConfig === "object" && dopplerConfig !== null
      ? {
          ...dopplerConfig,
          ...repoConfig,
          projectHostnameBases:
            repoConfig.projectHostnameBases ??
            ("projectHostnameBases" in dopplerConfig
              ? dopplerConfig.projectHostnameBases
              : undefined),
        }
      : dopplerConfig,
  );
}

async function runPreviewDeployCommand(input: {
  app: PreviewAppRuntime;
  commandEnvironment: NodeJS.ProcessEnv;
  dopplerConfig: string;
  operation: "up" | "down";
  repositoryRoot: string;
  signal?: AbortSignal;
}) {
  // Destroys are erase-data-backed and require an explicit --env (trpc-cli
  // enforces the required flag; no DOPPLER_CONFIG fallback — a destructive
  // script must never pick its target from ambient shell state). Deploys
  // resolve the env from the DOPPLER_CONFIG the `doppler run` wrapper sets.
  const commandArgs =
    input.operation === "down"
      ? [...input.app.destroyCommandArgs, "--env", input.dopplerConfig]
      : input.app.deployCommandArgs;

  return await runCommand({
    args: [
      "run",
      "--project",
      input.app.dopplerProject,
      "--config",
      input.dopplerConfig,
      "--",
      ...commandArgs,
    ],
    command: "doppler",
    environment: input.commandEnvironment,
    signal: input.signal,
    workingDirectory: resolve(input.repositoryRoot, input.app.appPath),
  });
}

/**
 * Erase a preview slot's user data before handing the slot to a new holder.
 * Reclaim paths MUST run this: a reclaim only ever happens because the
 * previous holder's cleanup — which normally erases on the way out — failed
 * or never ran, so a reclaimed slot is dirty by definition. Deploying over
 * stale identity data breaks the next tenant (observed 2026-07-07 on
 * preview-5: 208 orphaned project-directory KV keys against an empty auth D1
 * → every itx project lookup answered "KV GET failed: 500").
 */
type EraseSlotData = (input: { dopplerConfig: string; slug: string }) => Promise<void>;

/**
 * Every app that owns slot-persistent data. OS wipes the shared data plane;
 * the streams playground separately owns its StreamDurableObject namespace.
 */
function selectPreviewSlotDataOwners() {
  return [cloudflarePreviewApps.os, cloudflarePreviewApps["streams-example-app"]] as const;
}

function makePreviewSlotDataEraser(runtime: {
  commandEnvironment: NodeJS.ProcessEnv;
  repositoryRoot: string;
  signal?: AbortSignal;
}): EraseSlotData {
  return async ({ dopplerConfig, slug }) => {
    const startedAt = Date.now();
    logPreview(`erasing ${slug} data before handover (doppler config ${dopplerConfig})`);
    for (const app of selectPreviewSlotDataOwners()) {
      const result = await runPreviewDeployCommand({
        app,
        commandEnvironment: runtime.commandEnvironment,
        dopplerConfig,
        operation: "down",
        repositoryRoot: runtime.repositoryRoot,
        signal: runtime.signal,
      });
      if (result.exitCode !== 0) {
        throw new Error(
          commandFailureMessage(result, `Erasing ${slug} ${app.displayName} data failed.`),
        );
      }
    }
    logPreview(`erased ${slug} data (${formatDurationMs(Date.now() - startedAt)})`);
  };
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
 * by `preview status` so "9 open PRs" is not compared apples-to-oranges with
 * the 9-slot fleet.
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
        // What `eraseSlotData` needs to wipe the slot. Falls back to the
        // slug-derived config (preview-3 → preview_3) for slots that have
        // never been leased and so carry no data payload yet.
        dopplerConfig:
          typeof resource.data.dopplerConfig === "string" && resource.data.dopplerConfig.trim()
            ? resource.data.dopplerConfig.trim()
            : resource.slug.replaceAll("-", "_"),
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
 * Erase a just-acquired slot before it is handed to the caller, giving the
 * lease back on failure. Returns true when the slot is clean and ours.
 *
 * This runs on EVERY handover — plain acquire included, not just reclaims —
 * so slot cleanliness is an invariant of entry rather than an assumption
 * about how the previous tenant exited. Every exit path that skips the
 * cleanup erase (failed cleanup + 24h lease expiry, `release --force`, a run
 * cancelled mid-claim) becomes harmless: whoever picks the slot up next
 * wipes it first. A failed erase releases the lease rather than handing out
 * a dirty slot, and the released slot is safe back in the pool because its
 * next taker runs this same erase.
 */
async function eraseAcquiredSlotOrGiveItBack(input: {
  eraseSlotData: EraseSlotData;
  lease: { data: Record<string, unknown>; leaseId: string; slug: string; type: string };
  semaphore: PreviewSemaphoreResourceClient;
}) {
  try {
    await input.eraseSlotData({
      dopplerConfig: parseEnvironmentConfigLeaseData(input.lease.data).dopplerConfig,
      slug: input.lease.slug,
    });
    return true;
  } catch (error) {
    logPreview(
      `erase failed on just-acquired ${input.lease.slug} — giving the lease back (the next taker erases before use): ${error instanceof Error ? error.message : String(error)}`,
    );
    await input.semaphore
      .release({ type: input.lease.type, slug: input.lease.slug, leaseId: input.lease.leaseId })
      .catch((releaseError: unknown) => {
        logPreview(
          `failed to release ${input.lease.slug} after the failed erase (it will expire on its own, and its next taker still erases first): ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
        );
      });
    return false;
  }
}

/**
 * Acquire any free slot, queueing (via semaphore long-poll) while all slots
 * are leased. Automation never force-acquires a held slot: a close-triggered
 * cleanup owns its lease until teardown finishes and releases it, which keeps
 * another PR from erasing or deploying into that slot concurrently. Every
 * handed-out slot is erased first (see eraseAcquiredSlotOrGiveItBack). Fails
 * with the full holder table and remediation steps once `waitTotalMs` elapses.
 */
async function acquireAnyEnvironmentConfigLease(input: {
  semaphore: PreviewSemaphoreResourceClient;
  /** Required so no acquire path can hand out a slot without wiping it. */
  eraseSlotData: EraseSlotData;
  holder: string;
  leaseMs: number;
  onFirstWait?: (holderTable: string) => Promise<void>;
  waitTotalMs: number;
}) {
  const deadline = Date.now() + input.waitTotalMs;
  let attempt = 0;
  // Slots whose erase already failed this run. A free-but-unerasable slot
  // comes straight back from the semaphore after we release it, so without
  // a pause the loop hot-cycles the same broken slot (observed 2026-07-09:
  // three unerasable slots, ~6s per lap, 150+ laps burning the entire wait
  // budget while spamming the log). Erase is expected to self-heal now
  // (do-reset resurrects unlisted classes), so a repeat failure means the
  // slot needs a human/agent — pause to let other slots free up instead of
  // thrashing, and say so once.
  const eraseFailuresBySlug = new Map<string, number>();
  const brokenSlotPauseMs = 30_000;

  for (;;) {
    attempt += 1;
    const remainingMs = deadline - Date.now();
    // The first attempt returns immediately so contention is surfaced before
    // any long-poll; later attempts queue on the semaphore in 5-minute polls.
    const waitMs = attempt === 1 ? 0 : Math.max(0, Math.min(slotWaitPerAttemptMs, remainingMs));
    try {
      const acquired = await input.semaphore.acquire({
        allowedSlugs: previewEnvironmentSlugs,
        type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
        leaseMs: input.leaseMs,
        waitMs,
        holder: input.holder,
      });
      if (
        await eraseAcquiredSlotOrGiveItBack({
          eraseSlotData: input.eraseSlotData,
          lease: acquired,
          semaphore: input.semaphore,
        })
      ) {
        return acquired;
      }
      // Bound the acquire→failed-erase→release cycle: without this check the
      // loop would spin on a free-but-unerasable slot past the wait budget.
      if (Date.now() >= deadline) {
        throw new Error(
          `Could not hand ${input.holder} a clean slot: erasing ${acquired.slug} kept failing and the ${formatDurationMs(input.waitTotalMs)} wait budget is spent.`,
        );
      }
      const eraseFailures = (eraseFailuresBySlug.get(acquired.slug) ?? 0) + 1;
      eraseFailuresBySlug.set(acquired.slug, eraseFailures);
      if (eraseFailures === 2) {
        logPreview(
          `${acquired.slug} failed erase twice — it needs repair (scripts/lib/do-reset.ts header has the recipe). ` +
            `Pausing ${brokenSlotPauseMs / 1000}s between further attempts instead of hot-cycling it.`,
        );
      }
      if (eraseFailures >= 2) {
        await new Promise((res) =>
          setTimeout(res, Math.min(brokenSlotPauseMs, Math.max(0, deadline - Date.now()))),
        );
      }
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
 * Claim a slot for a PR deploy: adopt-or-claim, with the semaphore as the
 * single source of lease truth.
 *
 * 1. Adopt whatever the semaphore already attributes to this holder — a live
 *    lease from a previous run, or one a cancelled run claimed but never
 *    recorded (observed 2026-07-04: pr-1634 and pr-1636 each held two slots
 *    and every deploy queued for 20 minutes; adopting instead of acquiring a
 *    second slot is what prevents that). Adoption re-issues the lease, which
 *    doubles as the renewal, so no stored leaseId is ever consulted. The PR
 *    body's recorded slug is only a data-provenance hint here: an adopted
 *    slot that IS the recorded one carries this PR's own deployment and is
 *    never wiped; any other adopted slot has unknown provenance (the run
 *    that acquired it died before recording — possibly mid-erase) and is
 *    erased before handover.
 * 2. Re-take the recorded slot when its lease lapsed but nobody else claimed
 *    it — slot affinity keeps a lapsed PR on its own deployment instead of
 *    forcing a full redeploy elsewhere.
 * 3. Otherwise queue for any free slot.
 */
async function claimEnvironmentConfigLease(input: {
  eraseSlotData: EraseSlotData;
  holder: string;
  leaseMs: number;
  onFirstWait?: (holderTable: string) => Promise<void>;
  recordedSlug: string | null;
  semaphore: PreviewSemaphoreResourceClient;
  waitTotalMs: number;
}) {
  const adopted = await adoptLeaseHeldBySemaphore({
    holder: input.holder,
    leaseMs: input.leaseMs,
    onAdopted: (lease) =>
      lease.slug === input.recordedSlug
        ? Promise.resolve(true)
        : eraseAcquiredSlotOrGiveItBack({
            eraseSlotData: input.eraseSlotData,
            lease,
            semaphore: input.semaphore,
          }),
    preferSlug: input.recordedSlug,
    semaphore: input.semaphore,
  });
  if (adopted) {
    return adopted;
  }

  const retaken = await retakeRecordedSlotIfFree({
    holder: input.holder,
    leaseMs: input.leaseMs,
    recordedSlug: input.recordedSlug,
    semaphore: input.semaphore,
  });
  if (retaken) {
    return retaken;
  }

  const lease = await acquireAnyEnvironmentConfigLease({
    semaphore: input.semaphore,
    eraseSlotData: input.eraseSlotData,
    holder: input.holder,
    leaseMs: input.leaseMs,
    onFirstWait: input.onFirstWait,
    waitTotalMs: input.waitTotalMs,
  });
  logPreview(
    `lease acquired: ${lease.slug} held by ${input.holder} until ${formatUntil(lease.expiresAt)}`,
  );
  return toEnvironmentConfigLease(lease);
}

/**
 * Core of `preview assign`: keep the slot the semaphore says this holder has
 * (re-issued, which renews it) when it satisfies the request, otherwise take
 * the wanted slot (or any free one) and release the previously-held lease so
 * it doesn't stay claimed against a slot the PR no longer records. Ownership
 * comes from the semaphore; the recorded slug is only an affinity hint.
 */
async function assignEnvironmentConfigLease(input: {
  eraseSlotData: EraseSlotData;
  force?: boolean;
  holder: string;
  leaseMs: number;
  recordedSlug: string | null;
  semaphore: PreviewSemaphoreResourceClient;
  wantedSlug: string | null;
}): Promise<{
  lease: EnvironmentConfigLease;
  outcome: "kept" | "assigned" | "moved";
  changedFromSlug: string | null;
  previousLeaseReleased: boolean;
}> {
  const heldLease =
    (await adoptLeaseHeldBySemaphore({
      holder: input.holder,
      leaseMs: input.leaseMs,
      onAdopted: (lease) =>
        lease.slug === input.recordedSlug
          ? Promise.resolve(true)
          : eraseAcquiredSlotOrGiveItBack({
              eraseSlotData: input.eraseSlotData,
              lease,
              semaphore: input.semaphore,
            }),
      preferSlug: input.recordedSlug,
      semaphore: input.semaphore,
    })) ??
    (await retakeRecordedSlotIfFree({
      holder: input.holder,
      leaseMs: input.leaseMs,
      recordedSlug: input.recordedSlug,
      semaphore: input.semaphore,
    }));
  if (heldLease && (!input.wantedSlug || input.wantedSlug === heldLease.slug)) {
    return {
      lease: heldLease,
      outcome: "kept",
      changedFromSlug: null,
      previousLeaseReleased: false,
    };
  }

  let lease: EnvironmentConfigLease;
  if (input.wantedSlug) {
    try {
      const currentHolder = await findEnvironmentConfigLeaseHolder(
        input.semaphore,
        input.wantedSlug,
      );
      const resumeInterruptedMove = currentHolder === input.holder;
      if (resumeInterruptedMove) {
        logPreview(
          `continuing interrupted move: ${input.holder} already holds requested slot ${input.wantedSlug}`,
        );
      } else if (input.force && currentHolder) {
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
        // Semaphore intentionally rejects every active lease without force,
        // including another lease held by this same holder. Re-issue that one
        // exactly like adoption, then release the old recorded slot below.
        force: input.force || resumeInterruptedMove,
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
      const clean = await eraseAcquiredSlotOrGiveItBack({
        eraseSlotData: input.eraseSlotData,
        lease: acquired,
        semaphore: input.semaphore,
      });
      if (!clean) {
        throw new Error(
          `Erasing ${acquired.slug} failed, so its lease was given back rather than assigning a dirty slot. Retry, or pick another slot.`,
        );
      }
      lease = toEnvironmentConfigLease(acquired);
    } catch (error) {
      if (!heldLease || heldLease.slug === input.recordedSlug) throw error;
      try {
        const released = await input.semaphore.release({
          type: heldLease.type,
          slug: heldLease.slug,
          leaseId: heldLease.leaseId,
        });
        logPreview(
          released.released
            ? `requested slot assignment failed; released unrelated held slot ${heldLease.slug}`
            : `requested slot assignment failed; unrelated held slot ${heldLease.slug} was already gone`,
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
        eraseSlotData: input.eraseSlotData,
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
    previousLeaseReleased = released.released;
    logPreview(
      released.released
        ? `previous slot ${heldLease.slug} released — any deployment still there is now unprotected`
        : `previous slot ${heldLease.slug} was already gone`,
    );
  }

  const previousSlug = heldLease?.slug ?? input.recordedSlug;
  return {
    lease,
    outcome: heldLease ? "moved" : "assigned",
    changedFromSlug: previousSlug && previousSlug !== lease.slug ? previousSlug : null,
    previousLeaseReleased,
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

/** The slots the semaphore currently leases to this holder (usually 0 or 1; >1 heals via adoption). */
async function listSlotsLeasedToHolder(semaphore: PreviewSemaphoreResourceClient, holder: string) {
  const resources = await semaphore.list({ type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE });
  return resources.filter(
    (resource) => resource.leaseState === "leased" && resource.holder === holder,
  );
}

/**
 * The semaphore-truth ownership primitive: find the slot(s) the semaphore
 * currently leases to this holder and re-issue the preferred one under a
 * fresh leaseId (safe force: the slot is already ours). The re-issue doubles
 * as the renewal, so callers never store or compare leaseIds — dual-truth
 * comparisons between a recorded lease and the semaphore's answer are what
 * produced the steal-then-skip bugs this replaced. This also heals the
 * acquire-then-cancelled gap where a lease exists server-side but was never
 * recorded in the PR body, so a holder never accumulates a second slot
 * (preferSlug wins; extra holds expire on their own).
 *
 * onAdopted is a per-lease ready check (deploy erases unknown-provenance
 * slots there); returning false moves on to the holder's next slot, if any.
 */
async function adoptLeaseHeldBySemaphore(input: {
  holder: string;
  leaseMs: number;
  onAdopted?: (lease: PreviewSemaphoreLease) => Promise<boolean>;
  preferSlug: string | null;
  semaphore: PreviewSemaphoreResourceClient;
}): Promise<EnvironmentConfigLease | null> {
  const held = (await listSlotsLeasedToHolder(input.semaphore, input.holder)).sort(
    (left, right) =>
      Number(right.slug === input.preferSlug) - Number(left.slug === input.preferSlug),
  );
  for (const resource of held) {
    const reissued = await input.semaphore.acquireSpecific({
      allowedSlugs: previewEnvironmentSlugs,
      type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
      slug: resource.slug,
      leaseMs: input.leaseMs,
      holder: input.holder,
      force: true,
    });
    if (!reissued) {
      continue;
    }
    logPreview(
      `lease held: the semaphore attributes ${reissued.slug} to ${input.holder}; ` +
        `re-issued (renewed) until ${formatUntil(reissued.expiresAt)}`,
    );
    if (input.onAdopted && !(await input.onAdopted(reissued))) {
      continue;
    }
    return toEnvironmentConfigLease(reissued);
  }
  return null;
}

/**
 * Slot affinity for a lapsed lease: the PR body says this PR's deployment
 * lives on recordedSlug, and if the semaphore says nobody holds that slot,
 * take it back. Non-force, so the semaphore still arbitrates — a slot someone
 * else holds returns null and the caller refuses or moves elsewhere; the
 * recorded slug is only a hint about where to look, never authority. No
 * erase: the deployment on the slot is this PR's own.
 */
async function retakeRecordedSlotIfFree(input: {
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
    `lease re-acquired: ${retaken.slug} had lapsed but was still free; ${input.holder} holds it again until ${formatUntil(retaken.expiresAt)}`,
  );
  return toEnvironmentConfigLease(retaken);
}

/**
 * Why a slot action was refused: the semaphore no longer attributes a slot
 * to this holder. CONTRACT: the message always contains the exact substring
 * "no longer belongs to" — scripts/preview/flake-hunt-loop.sh and on-call
 * humans grep for it to tell a slot steal apart from ordinary failures.
 * Change both sides together.
 */
function describeLostSlotOwnership(input: {
  currentHolder: string | null;
  displaySlot: CloudflarePreviewSlotDisplay | null;
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
 * erase-data on the slot (the documented remedy when merged-main lands a
 * non-migratable schema change) parks the os worker behind a 503 and wipes
 * the slot's shared data WITHOUT touching the recorded PR-body state. Trusting
 * the stale green rows then redeploys only the failed apps and leaves the slot
 * half-dead: observed 2026-07-09 on preview-7 (PR #1793), where e2e failed
 * with "no such column: epoch", the erase parked os and emptied auth's D1
 * (OAuth clients), and the retry — os and auth both recorded green — never
 * redeployed either; auth had to be redeployed by hand. Probing each green
 * app's readiness URL once makes erase + re-run self-healing: the parked app
 * fails its probe, joins the retry selection, and pulls its dependencies
 * (auth, whose OAuth-client seed lives in the wiped D1) along via
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
        `app ${app.slug} selected: recorded ${entry.status} but not actually serving (${probeFailures.join("; ")}) — the slot was likely erased since that deploy`,
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
  // ran (a cancelled run), so redeploying it at the current head — idempotent
  // and cheap — is what makes the test lane's "no app recorded at this head"
  // an honest green skip (observed 2026-07-10: run 7 deployed then got
  // cancelled by run 8's push; run 8's one-line non-app diff then skipped
  // green while every app sat at awaiting-tests).
  const retrySlugs = Object.values(params.previousState.apps)
    .filter((entry) =>
      ["awaiting-tests", "claim-failed", "deploy-failed", "tests-failed"].includes(entry.status),
    )
    .map((entry) => CloudflarePreviewAppSlug.parse(entry.appSlug));

  return expandPreviewDependencies(retrySlugs).map((slug) => cloudflarePreviewApps[slug]);
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
  readinessBearerToken?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  workerVersion?: { expected: string } & PreviewReadyWorkerVersion;
}) {
  const urls = resolvePreviewReadinessUrls({
    publicUrl: params.publicUrl,
    readyUrlPath: params.readyUrlPath,
  });

  for (const url of urls) {
    const readiness = await waitForHttpReadiness({
      readinessBearerToken: params.readinessBearerToken,
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
  readinessBearerToken?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  url: URL;
  workerVersion?: { expected: string } & PreviewReadyWorkerVersion;
}) {
  const startedAt = Date.now();
  const deadline = Date.now() + params.timeoutMs;
  const hasProbeQueryParam = params.workerVersion?.probeQueryParam !== undefined;
  const hasProbeWaveCount = params.workerVersion?.probeWaveCount !== undefined;

  if (hasProbeQueryParam !== hasProbeWaveCount) {
    throw new Error(
      "Worker-version readiness must configure probeQueryParam and probeWaveCount together.",
    );
  }

  if (hasProbeQueryParam && hasProbeWaveCount && params.workerVersion) {
    const { probeQueryParam, probeWaveCount } = params.workerVersion;
    if (probeQueryParam === undefined || probeWaveCount === undefined) {
      throw new Error("Worker-version readiness probe configuration is incomplete.");
    }
    return await waitForWorkerVersionProbeWaves({
      deadline,
      readinessBearerToken: params.readinessBearerToken,
      signal: params.signal,
      startedAt,
      url: params.url,
      workerVersion: {
        expected: params.workerVersion.expected,
        probeQueryParam,
        probeWaveCount,
        stableForMs: params.workerVersion.stableForMs,
      },
    });
  }

  let lastFailure = "No response received yet.";
  let matchingWorkerVersionSince: number | null = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetchReadinessResponse(params.url, {
        readinessBearerToken: params.readinessBearerToken,
        signal: params.signal,
        timeoutMs: readinessRequestTimeoutMs(deadline),
      });
      if (response.status >= 200 && response.status < 300) {
        params.signal?.throwIfAborted();
        if (Date.now() >= deadline) break;
        if (!params.workerVersion) {
          return { ok: true as const };
        }

        if (response.workerVersion === params.workerVersion.expected) {
          const now = Date.now();
          matchingWorkerVersionSince ??= now;
          const stableForMs = now - matchingWorkerVersionSince;
          if (stableForMs >= params.workerVersion.stableForMs) {
            return { ok: true as const };
          }

          lastFailure =
            `Readiness check reported Worker version ${params.workerVersion.expected}, ` +
            `but it has only remained stable for ${stableForMs}ms of the required ${params.workerVersion.stableForMs}ms.`;
        } else {
          matchingWorkerVersionSince = null;
          lastFailure =
            `Readiness check reported Worker version ${response.workerVersion ?? "<missing>"}; ` +
            `expected ${params.workerVersion.expected}.`;
        }
      } else {
        matchingWorkerVersionSince = null;
        lastFailure =
          `Readiness check returned ${response.status} for ${params.url.toString()}` +
          formatReadinessResponseDetail(response);
      }
    } catch (error) {
      matchingWorkerVersionSince = null;
      lastFailure = formatPreviewErrorMessage(error);
    }

    await sleep(Math.min(1_000, Math.max(0, deadline - Date.now())), params.signal);
  }

  return {
    message: `Timed out waiting for preview readiness at ${params.url.toString()}. ${lastFailure}`,
    ok: false as const,
  };
}

type WorkerVersionProbeResult = {
  failure: string | null;
  terminal: boolean;
  wave: number;
};

/**
 * Exercise every bounded Durable Object readiness wave concurrently. A wave
 * that has already reported the exact deployment stays out of the hot retry
 * set; once every wave has passed, one complete set is checked again after the
 * stability interval. A slow request cannot let readiness expire without
 * revisiting the last failed wave.
 */
async function waitForWorkerVersionProbeWaves(params: {
  deadline: number;
  readinessBearerToken?: string;
  signal?: AbortSignal;
  startedAt: number;
  url: URL;
  workerVersion: {
    expected: string;
    probeQueryParam: string;
    probeWaveCount: number;
    stableForMs: number;
  };
}) {
  const { probeWaveCount } = params.workerVersion;
  if (!Number.isSafeInteger(probeWaveCount) || probeWaveCount < 1 || probeWaveCount > 64) {
    throw new Error("Worker-version readiness probeWaveCount must be an integer from 1 to 64.");
  }

  const allWaves = Array.from({ length: probeWaveCount }, (_, wave) => wave);
  let pendingWaves = new Set(allWaves);
  let lastFailure = "No probe wave has completed yet.";
  let lastProgress = "";
  let lastProgressAt = 0;

  while (Date.now() < params.deadline) {
    const results = await probeWorkerVersionWaves({
      deadline: params.deadline,
      expectedWorkerVersion: params.workerVersion.expected,
      probeQueryParam: params.workerVersion.probeQueryParam,
      probeWaveCount,
      readinessBearerToken: params.readinessBearerToken,
      signal: params.signal,
      url: params.url,
      waves: [...pendingWaves],
    });
    const terminalFailure = results.find((result) => result.terminal);
    if (terminalFailure?.failure) {
      return {
        message: `Preview readiness failed at ${params.url.toString()}. ${terminalFailure.failure}`,
        ok: false as const,
      };
    }
    for (const result of results) {
      if (result.failure === null) pendingWaves.delete(result.wave);
    }

    if (pendingWaves.size > 0) {
      const failures = results.filter((result) => result.failure !== null);
      lastFailure = describeWorkerVersionProbeFailures(failures);
      const progress = `${probeWaveCount - pendingWaves.size}/${probeWaveCount}`;
      const now = Date.now();
      if (progress !== lastProgress || now - lastProgressAt >= 10_000) {
        console.error(
          `[preview] readiness ${params.url.origin}: ${progress} Durable Object probe waves have served version ${params.workerVersion.expected}; ${lastFailure}`,
        );
        lastProgress = progress;
        lastProgressAt = now;
      }
      await sleep(Math.min(1_000, Math.max(0, params.deadline - Date.now())), params.signal);
      continue;
    }

    const remainingStabilityBudgetMs = params.deadline - Date.now();
    if (remainingStabilityBudgetMs < params.workerVersion.stableForMs) {
      lastFailure =
        `All waves served the expected version, but only ${Math.max(0, remainingStabilityBudgetMs)}ms ` +
        `remained for the required ${params.workerVersion.stableForMs}ms stability interval.`;
      break;
    }
    console.error(
      `[preview] readiness ${params.url.origin}: all ${probeWaveCount} Durable Object probe waves served ${params.workerVersion.expected}; revalidating after ${formatDurationMs(params.workerVersion.stableForMs)}`,
    );
    await sleep(params.workerVersion.stableForMs, params.signal);
    params.signal?.throwIfAborted();
    if (Date.now() >= params.deadline) {
      lastFailure = "The readiness deadline expired before complete-set revalidation began.";
      break;
    }

    const validationResults = await probeWorkerVersionWaves({
      deadline: params.deadline,
      expectedWorkerVersion: params.workerVersion.expected,
      probeQueryParam: params.workerVersion.probeQueryParam,
      probeWaveCount,
      readinessBearerToken: params.readinessBearerToken,
      signal: params.signal,
      url: params.url,
      waves: allWaves,
    });
    params.signal?.throwIfAborted();
    const terminalValidationFailure = validationResults.find((result) => result.terminal);
    if (terminalValidationFailure?.failure) {
      return {
        message:
          `Preview readiness failed at ${params.url.toString()}. ` +
          terminalValidationFailure.failure,
        ok: false as const,
      };
    }
    const validationFailures = validationResults.filter((result) => result.failure !== null);
    if (validationFailures.length === 0 && Date.now() < params.deadline) {
      console.error(
        `[preview] readiness ${params.url.origin}: all ${probeWaveCount} waves remained exact; ready after ${formatDurationMs(Date.now() - params.startedAt)}`,
      );
      return { ok: true as const };
    }
    if (Date.now() >= params.deadline) {
      lastFailure = "The readiness deadline expired during complete-set revalidation.";
      break;
    }

    pendingWaves = new Set(validationFailures.map((result) => result.wave));
    lastFailure = describeWorkerVersionProbeFailures(validationFailures);
    console.error(
      `[preview] readiness ${params.url.origin}: complete-set revalidation found ${lastFailure}; retrying only those waves`,
    );
    lastProgress = "";
    await sleep(Math.min(1_000, Math.max(0, params.deadline - Date.now())), params.signal);
  }

  return {
    message: `Timed out waiting for preview readiness at ${params.url.toString()}. ${lastFailure}`,
    ok: false as const,
  };
}

async function probeWorkerVersionWaves(params: {
  deadline: number;
  expectedWorkerVersion: string;
  probeQueryParam: string;
  probeWaveCount: number;
  readinessBearerToken?: string;
  signal?: AbortSignal;
  url: URL;
  waves: readonly number[];
}): Promise<WorkerVersionProbeResult[]> {
  return await Promise.all(
    params.waves.map(async (wave) => {
      const requestUrl = new URL(params.url);
      requestUrl.searchParams.set(params.probeQueryParam, String(wave));
      try {
        const response = await fetchReadinessResponse(requestUrl, {
          readinessBearerToken: params.readinessBearerToken,
          signal: params.signal,
          timeoutMs: readinessRequestTimeoutMs(params.deadline),
        });
        if (response.status < 200 || response.status >= 300) {
          const recognizedSettlingResponse =
            response.settlingReason === "durable-object-lifecycle" ||
            response.settlingReason === "probe-timeout" ||
            response.settlingReason === "version-mismatch";
          // During edge rollout Cloudflare can return a framework-generated 5xx
          // without the Worker's version header. That response cannot be
          // attributed to the deployment we are proving, so keep it inside the
          // bounded rollout window. An unexplained 5xx explicitly served by the
          // expected version is an application failure and remains terminal.
          const servedByExpectedWorker = response.workerVersion === params.expectedWorkerVersion;
          const terminal =
            [400, 401, 403].includes(response.status) ||
            (response.status >= 500 && !recognizedSettlingResponse && servedByExpectedWorker);
          return {
            failure:
              `wave ${wave} returned HTTP ${response.status}` +
              formatReadinessResponseDetail(response),
            terminal,
            wave,
          };
        }
        if (response.workerVersion !== params.expectedWorkerVersion) {
          return {
            failure: `wave ${wave} served Worker version ${response.workerVersion ?? "<missing>"}`,
            terminal: false,
            wave,
          };
        }
        if (
          response.deploymentProbeWave !== wave ||
          response.deploymentProbeWaveCount !== params.probeWaveCount
        ) {
          return {
            failure:
              `wave ${wave} returned probe identity ` +
              `${response.deploymentProbeWave ?? "<missing>"}/` +
              `${response.deploymentProbeWaveCount ?? "<missing>"}; ` +
              `expected ${wave}/${params.probeWaveCount}`,
            terminal: true,
            wave,
          };
        }
        return { failure: null, terminal: false, wave };
      } catch (error) {
        return {
          failure: `wave ${wave} failed: ${formatPreviewErrorMessage(error)}`,
          terminal: false,
          wave,
        };
      }
    }),
  );
}

function describeWorkerVersionProbeFailures(results: readonly WorkerVersionProbeResult[]) {
  const descriptions = results
    .map((result) => result.failure)
    .filter((failure): failure is string => failure !== null);
  return descriptions.length === 0 ? "no failed waves" : descriptions.join("; ");
}

async function fetchReadinessResponse(
  url: URL,
  options: {
    readinessBearerToken?: string;
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
  const headers = options.readinessBearerToken
    ? { authorization: `Bearer ${options.readinessBearerToken}` }
    : undefined;
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers,
      method: "GET",
      redirect: "follow",
      signal: requestSignal,
    });
    return parseReadinessResponse({
      body: await readBoundedResponseBody(response),
      status: response.status,
      workerVersion: response.headers.get(workerVersionReadinessHeader),
    });
  } catch (error) {
    if (!isDnsLookupError(error)) {
      throw error;
    }

    return await requestReadinessWithDnsResolve({
      readinessBearerToken: options.readinessBearerToken,
      signal: requestSignal,
      url,
    });
  }
}

type ReadinessResponse = {
  body: string;
  deploymentProbeWave: number | null;
  deploymentProbeWaveCount: number | null;
  settlingReason: string | null;
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

function parseReadinessResponse(input: {
  body: string;
  status: number;
  workerVersion: string | null;
}): ReadinessResponse {
  let parsed: unknown = null;
  try {
    parsed = input.body ? JSON.parse(input.body) : null;
  } catch {
    // Non-JSON proxy and platform errors remain useful as bounded diagnostics.
  }
  const record =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  return {
    ...input,
    deploymentProbeWave: readSafeInteger(record?.deploymentProbeWave),
    deploymentProbeWaveCount: readSafeInteger(record?.deploymentProbeWaveCount),
    settlingReason: typeof record?.settlingReason === "string" ? record.settlingReason : null,
  };
}

function readSafeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) ? (value as number) : null;
}

function formatReadinessResponseDetail(response: ReadinessResponse): string {
  const detail = response.body.trim().replace(/\s+/g, " ");
  return detail ? `: ${detail}` : "";
}

function readinessRequestTimeoutMs(deadline: number): number {
  return Math.max(1, Math.min(previewReadinessRequestTimeoutMs, deadline - Date.now()));
}

async function requestReadinessWithDnsResolve(input: {
  readinessBearerToken?: string;
  signal?: AbortSignal;
  url: URL;
}) {
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
    if (input.readinessBearerToken) {
      headers.authorization = `Bearer ${input.readinessBearerToken}`;
    }
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
          resolve(
            parseReadinessResponse({
              body: truncated ? `${body}…` : body,
              status: statusCode,
              workerVersion,
            }),
          ),
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
  adoptLeaseHeldBySemaphore,
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
  retakeRecordedSlotIfFree,
  resolveSlotWaitTotalMs,
  selectExpiredLeasesForGc,
  expandPreviewDependencies,
  orderPreviewDeployBatches,
  parseLastDeployedWorkerVersionId,
  parseCloudflarePreviewState,
  parseEnvironmentConfigLeaseData,
  readPlaywrightTestTelemetry,
  readPreviewAppConfig,
  readVitestTestTelemetry,
  reconcileEnvironmentConfigLeaseResources,
  releaseLeaseDespiteTeardownFailure,
  renderCloudflarePreviewPullRequestBody,
  renderPreviewRetrySummary,
  previewTestFailureMessage,
  resolveAuthPreviewRootSecret,
  resolveProvisionAuthPreviewSlotNumbers,
  resolveRequestedPreviewEnvironment,
  resolvePreviewCompareBaseSha,
  resolvePreviewOsContainerRollout,
  resolvePreviewReadinessUrls,
  resolvePreviewTestBaseUrlEnvironment,
  resolvePreviewTestTargetPlan,
  resolvePreviewTestWorkerVersionOverrides,
  selectPreviewAppsForPullRequest,
  selectPreviewAppsNeedingRetry,
  selectPreviewSlotDataOwners,
  splitRepositoryFullName,
  syncPreviewInventory,
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
