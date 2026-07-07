import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as dns } from "node:dns";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolve } from "node:path";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { createSemaphoreClient } from "../../apps/semaphore/src/contract.ts";
import { createSemaphoreTokenProvider } from "../auth/semaphore-token.ts";
import { markdownAnnotator } from "../../packages/shared/src/dev/markdown-annotator.ts";
import { stripAnsi } from "../../packages/shared/src/dev/strip-ansi.ts";
import { runCommand } from "../../packages/shared/src/node/run-command.ts";
import { OS_PREVIEW_VITEST_LANE_TIMEOUT_SECS } from "../../packages/shared/src/test-support/e2e-policy/index.ts";

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
 * a lease (it was ready once, or opted out again) gives its slot back.
 */
function decideDraftPreviewPolicy(input: {
  allowDraft: boolean;
  hasRecordedLease: boolean;
  isDraft: boolean;
  labels: string[];
}): "deploy" | "skip" | "teardown" {
  if (!input.isDraft || input.allowDraft || input.labels.includes(previewOptInLabel)) {
    return "deploy";
  }

  return input.hasRecordedLease ? "teardown" : "skip";
}

/**
 * Deploy affected preview apps for a pull request without running preview e2e.
 */
export async function deploy(
  options: PullRequestCommandOptions & {
    /**
     * Deploy every preview app regardless of the diff. Diff selection only
     * redeploys apps affected since their LAST DEPLOYED head, so unaffected
     * apps keep an older recorded head and the test lane then skips them
     * ("stale — deploy has not run for the current head yet"). A caller that
     * needs the whole fleet testable at the current head — the flake-hunt
     * marathon preflight — uses this to reunify the fleet explicitly instead
     * of relying on the commit happening to touch a fleet-shared path.
     */
    allApps?: boolean;
    /**
     * Deploy even when the PR is a draft without the `preview` label. Draft
     * PRs otherwise skip previews (or give their slot back); an explicit
     * invocation — workflow_dispatch, the flake-hunt marathon, a human at a
     * terminal — is an ask, so those callers pass this.
     */
    allowDraft?: boolean;
  } = {},
) {
  const runtime = createPreviewRuntime();
  const context = await resolvePullRequestPreviewContext({
    commandEnvironment: runtime.commandEnvironment,
    githubToken: resolveGithubToken(options, runtime.commandEnvironment),
    pullRequestNumber: resolvePullRequestNumber(options, runtime.commandEnvironment),
  });
  logPreview(
    `deploy for PR #${context.pullRequestNumber} (head ${context.pullRequestHeadSha.slice(0, 7)}) — holder ${pullRequestHolder(context.pullRequestNumber)}, semaphore ${defaultSemaphoreBaseUrl}`,
  );

  const current = await readCloudflarePreviewState(context);
  logPreview(
    current.state.environmentConfigLease
      ? `PR body records lease ${current.state.environmentConfigLease.slug} (doppler config ${current.state.environmentConfigLease.dopplerConfig}, recorded until ${formatUntil(current.state.environmentConfigLease.leasedUntil)})`
      : "PR body records no lease — this PR has no slot yet",
  );

  const draftPolicy = decideDraftPreviewPolicy({
    allowDraft: options.allowDraft === true,
    hasRecordedLease: current.state.environmentConfigLease != null,
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
      `draft PR without the ${previewOptInLabel} label holds ${current.state.environmentConfigLease?.slug} — tearing down and releasing the slot (mark ready, add the label, or pass --allow-draft to keep previews)`,
    );
    const cleanupResult = await cleanupPreviewForPullRequest({ ...runtime, context });
    if (!cleanupResult.ok) {
      throw new Error("Failed to tear down previews for a draft PR.");
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
      "nothing to deploy: no preview apps are affected by this diff and no failed apps need a retry — leaving lease and PR body untouched",
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

  let environmentConfigLease: EnvironmentConfigLease;
  try {
    environmentConfigLease = await claimEnvironmentConfigLease({
      createPreviewSemaphoreResourceClient: runtime.createPreviewSemaphoreResourceClient,
      fetchPullRequestState: makePullRequestStateFetcher(
        context.githubToken,
        context.repositoryFullName,
      ),
      holder: pullRequestHolder(context.pullRequestNumber),
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
      previousEnvironmentConfigLease: current.state.environmentConfigLease,
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
  const claimNotice =
    previousSlug && previousSlug !== environmentConfigLease.slug
      ? `This PR's slot changed from ${previousSlug} to ${environmentConfigLease.slug} at ${new Date().toISOString()} (the old lease lapsed and someone else took the slot). Everything below refers to the new slot.`
      : null;
  const leaseUpdate = await updatePreviewState(context, (state) => ({
    ...state,
    environmentConfigLease,
    notice: claimNotice,
  }));

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
          commandEnvironment: runtime.commandEnvironment,
          dopplerConfig: environmentConfigLease.dopplerConfig,
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
      environmentConfigLease,
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

/**
 * Run preview e2e against deployed apps recorded in the managed PR preview section.
 */
export async function test(options: PullRequestCommandOptions = {}) {
  const runtime = createPreviewRuntime();
  const context = await resolvePullRequestPreviewContext({
    commandEnvironment: runtime.commandEnvironment,
    githubToken: resolveGithubToken(options, runtime.commandEnvironment),
    pullRequestNumber: resolvePullRequestNumber(options, runtime.commandEnvironment),
  });

  logPreview(
    `test for PR #${context.pullRequestNumber} (head ${context.pullRequestHeadSha.slice(0, 7)}) — holder ${pullRequestHolder(context.pullRequestNumber)}, semaphore ${defaultSemaphoreBaseUrl}`,
  );
  const current = await readCloudflarePreviewState(context);
  const recordedLease = current.state.environmentConfigLease;
  if (recordedLease == null) {
    logPreview("PR body records no lease — nothing is deployed for this PR, skipping tests");
    return {
      ok: true,
      skipped: true,
      state: current.state,
    };
  }
  logPreview(
    `PR body records lease ${recordedLease.slug} (doppler config ${recordedLease.dopplerConfig}, recorded until ${formatUntil(recordedLease.leasedUntil)})`,
  );

  const testableApps = Object.values(current.state.apps)
    .filter((entry) => canRunPreviewTests(entry))
    .filter((entry) => entry.headSha === context.pullRequestHeadSha)
    .map((entry) => cloudflarePreviewApps[entry.appSlug as CloudflarePreviewAppSlugType])
    .filter((app): app is PreviewAppRuntime => app != null);

  if (testableApps.length === 0) {
    logPreview(
      [
        "no apps are testable for this head sha — skipping tests. Recorded app states:",
        ...Object.values(current.state.apps).map(
          (entry) =>
            `  ${entry.appSlug}: ${entry.status}, head ${entry.shortSha ?? "?"}${entry.headSha !== context.pullRequestHeadSha ? " (stale — deploy has not run for the current head yet)" : ""}`,
        ),
      ].join("\n"),
    );
    return {
      ok: true,
      skipped: true,
      state: current.state,
    };
  }
  logPreview(`testable apps: ${testableApps.map((app) => app.slug).join(", ")}`);

  // Re-assert the slot before hammering it with e2e: if the lease expired and
  // another PR took the slot, the deployment under test is no longer ours.
  const holder = pullRequestHolder(context.pullRequestNumber);
  const reasserted = await reassertEnvironmentConfigLease({
    holder,
    lease: recordedLease,
    leaseMs: defaultPreviewLeaseMs,
    semaphore: runtime.createPreviewSemaphoreResourceClient(),
  });
  if (!reasserted.ok) {
    await updatePreviewState(context, (state) => ({
      ...state,
      environmentConfigLease: null,
      notice: `${reasserted.message} E2e was NOT run. Re-run preview deploy to claim a slot and redeploy.`,
      apps: Object.fromEntries(
        Object.entries(state.apps).map(([appSlug, entry]) => [
          appSlug,
          // Older-head entries are already superseded; only current-head
          // entries are marked so deploy's retry selection picks them up.
          entry.headSha === context.pullRequestHeadSha
            ? {
                ...entry,
                status: "claim-failed" as const,
                message: reasserted.message,
                updatedAt: new Date().toISOString(),
              }
            : entry,
        ]),
      ),
    }));
    throw new Error(
      `Refusing to run preview tests: ${reasserted.message} Re-run "pnpm preview deploy" to claim a slot and redeploy.`,
    );
  }

  const environmentConfigLease = reasserted.lease;
  if (
    environmentConfigLease.leaseId !== recordedLease.leaseId ||
    environmentConfigLease.leasedUntil !== recordedLease.leasedUntil
  ) {
    await updatePreviewState(context, (state) => ({
      ...state,
      environmentConfigLease,
    }));
  }

  // Preview e2e commands are full app-level suites. They run concurrently:
  // each app deploys its own workers, and the non-OS suites are seconds-long
  // smokes whose load is negligible next to the OS lanes.
  const maybeEntries = await mapWithConcurrency(testableApps, testableApps.length, async (app) => {
    const existingEntry = current.state.apps[app.slug];
    if (!existingEntry?.publicUrl) {
      return null;
    }

    const startedAt = Date.now();
    logPreview(
      `test start: ${app.slug} against ${existingEntry.publicUrl} (doppler config ${environmentConfigLease.dopplerConfig})`,
    );
    const testResult = await runCommandWithRetries({
      args: [
        "run",
        "--project",
        app.dopplerProject,
        "--config",
        environmentConfigLease.dopplerConfig,
        "--",
        "env",
        `${app.previewTestBaseUrlEnvVar}=${existingEntry.publicUrl}`,
        ...app.previewTestCommandArgs,
      ],
      command: "doppler",
      environment: runtime.commandEnvironment,
      maxAttempts: defaultPreviewTestMaxAttempts,
      retryDelayMs: defaultPreviewTestRetryDelayMs,
      signal: runtime.signal,
      workingDirectory: resolve(runtime.repositoryRoot, app.appPath),
    });
    const testDurationMs = Date.now() - startedAt;
    console.error(
      `[preview] test ${testResult.exitCode === 0 ? "passed" : "failed"}: ${app.slug} (${formatDurationMs(testDurationMs)})`,
    );
    if (testResult.exitCode === 0) {
      warnIfOverBudget("e2e", app.slug, testDurationMs, app.previewTestBudgetMs);
    }

    // Collected pass or fail: on a red run the telemetry explains which tests
    // burned their retry before the failure. Never fails the lane.
    const retrySummary = app.collectRetryTelemetry
      ? await app
          .collectRetryTelemetry({ repositoryRoot: runtime.repositoryRoot })
          .catch((error): PreviewRetrySummary | null => {
            console.error(`[preview] retry telemetry collection failed for ${app.slug}:`, error);
            return null;
          })
      : null;
    if (retrySummary) {
      announceRetryTelemetry(app.slug, retrySummary);
    }

    return CloudflarePreviewAppEntry.parse({
      ...existingEntry,
      appDisplayName: app.displayName,
      appSlug: app.slug,
      message:
        testResult.exitCode === 0
          ? null
          : commandFailureMessage(testResult, "Preview tests failed after deploy."),
      runUrl: context.workflowRunUrl ?? existingEntry.runUrl ?? null,
      status: testResult.exitCode === 0 ? "deployed" : "tests-failed",
      testDurationMs,
      testRetries: retrySummary ? renderPreviewRetrySummary(retrySummary) : null,
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
    state: current.state,
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

  if (!result.ok) {
    throw new Error("Failed to clean up Cloudflare preview apps.");
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
    fetchPullRequestState: makePullRequestStateFetcher(
      context.githubToken,
      context.repositoryFullName,
    ),
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
  const needsRedeploy = result.outcome !== "kept";
  const redeployMessage = result.changedFromSlug
    ? `Slot reassigned from ${result.changedFromSlug} to ${result.lease.slug}; run preview deploy to redeploy here.`
    : `Slot ${result.lease.slug} was re-acquired after this PR's lease lapsed — previous deployments there may have been replaced. Run preview deploy to redeploy.`;
  const update = await updatePreviewState(context, (state) => ({
    ...state,
    environmentConfigLease: result.lease,
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
 * Show environment config lease inventory and active leases for PR previews.
 */
export async function status() {
  const runtime = createPreviewRuntime();
  const semaphore = runtime.createPreviewSemaphoreResourceClient();
  const now = Date.now();
  const resources = await semaphore.list({
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
  });
  const available = resources
    .filter((resource) => resource.leaseState === "available")
    .map((resource) => ({
      data: resource.data,
      slug: resource.slug,
      lastReleasedAt:
        resource.lastReleasedAt === null ? null : new Date(resource.lastReleasedAt).toISOString(),
    }));
  const leased = resources
    .filter((resource) => resource.leaseState === "leased")
    .map((resource) => ({
      data: resource.data,
      slug: resource.slug,
      holder: resource.holder ?? null,
      pullRequestUrl: holderPullRequestUrl(resource.holder),
      leasedUntil:
        resource.leasedUntil === null ? null : new Date(resource.leasedUntil).toISOString(),
      expiresInMs: resource.leasedUntil === null ? null : resource.leasedUntil - now,
      lastAcquiredAt:
        resource.lastAcquiredAt === null ? null : new Date(resource.lastAcquiredAt).toISOString(),
    }))
    .sort((left, right) => {
      if (left.leasedUntil === null) return 1;
      if (right.leasedUntil === null) return -1;
      return left.leasedUntil.localeCompare(right.leasedUntil);
    });

  return {
    checkedAt: new Date(now).toISOString(),
    semaphoreBaseUrl: defaultSemaphoreBaseUrl,
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
    total: resources.length,
    availableCount: available.length,
    leasedCount: leased.length,
    nextLeaseExpiryAt: leased[0]?.leasedUntil ?? null,
    available,
    leased,
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

/**
 * Resolve slot contention: report which leased slots are active/idle/orphaned, and take a non-active one back with --slot.
 */
type ReclaimOptions = {
  /** Preview slot to reclaim (number or slug). Omit for a report of every slot's verdict. */
  slot?: string;
  /** Hours without a deploy/test renewal before a hold counts as idle. */
  minIdleHours?: number;
  /** Also reclaim a slot whose holder is still active. Avoid: this clobbers live work. */
  force?: boolean;
  /** GitHub token used to check whether pr-N holders are closed. Defaults to GITHUB_TOKEN. */
  githubToken?: string;
};

export async function reclaim(options: ReclaimOptions = {}) {
  const runtime = createPreviewRuntime();
  const semaphore = runtime.createPreviewSemaphoreResourceClient();
  const githubToken =
    options.githubToken?.trim() || runtime.commandEnvironment.GITHUB_TOKEN?.trim();
  const fetchPullRequestState = githubToken
    ? makePullRequestStateFetcher(
        githubToken,
        runtime.commandEnvironment.GITHUB_REPOSITORY?.trim() || defaultRepositoryFullName,
      )
    : null;
  if (!fetchPullRequestState) {
    logPreview(
      "no GITHUB_TOKEN available — cannot check whether pr-* holders are closed, so verdicts are idle-time only (orphaned PRs show as idle/active)",
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
        .map((slot) => `pnpm preview reclaim --slot ${slot.slug}`),
      note: "orphaned = holder PR is closed, so its cleanup failed; idle = holder hasn't deployed/tested for a while; taking an active slot needs --force and clobbers live work",
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
  if (slot.verdict === "active" && !options.force) {
    throw new Error(
      [
        `${slug} is actively held by ${slot.holder ?? "unknown holder"}${slot.pullRequestUrl ? ` (${slot.pullRequestUrl})` : ""}:`,
        `  last used ${slot.lastUsedAgo ?? "recently"}, lease expires ${slot.leasedUntil ?? "soon"}.`,
        "Taking it would clobber live work. Re-run with --force only after checking with the holder.",
      ].join("\n"),
    );
  }

  logPreview(
    `reclaiming ${slug} from ${slot.holder ?? "unknown holder"} (${slot.verdict}${slot.lastUsedAgo ? `, last used ${slot.lastUsedAgo}` : ""})`,
  );
  const result = await semaphore.release({
    slug,
    type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
    force: true,
  });
  return {
    released: result.released,
    slug,
    reclaimedFrom: slot.holder,
    verdict: slot.verdict,
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
};

export async function provisionAuthPreviewConfigs(
  options: ProvisionAuthPreviewConfigsOptions = {},
) {
  await ensureAuthPreviewConfigs({
    rotate: Boolean(options.rotate),
  });

  return {
    rotated: Boolean(options.rotate),
    slots: previewEnvironmentSlotNumbers.length,
  };
}

export const CloudflarePreviewAppSlug = z.enum(["os", "semaphore", "auth", "streams-example-app"]);

export type CloudflarePreviewAppSlug = z.infer<typeof CloudflarePreviewAppSlug>;
type CloudflarePreviewAppSlugType = CloudflarePreviewAppSlug;

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
  paths: string[];
  previewDependencies?: CloudflarePreviewAppSlug[];
  /** Readiness probe path on the app's public URL (default /api/__internal/health). */
  previewReadyUrlPath?: string;
  previewTestBaseUrlEnvVar: string;
  previewTestArtifacts?: readonly [string, ...string[]];
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
   * Collect per-test retry telemetry after the app's preview test command
   * finishes (pass or fail) — policy rule 5, retries are measured, never
   * silent (docs/testing.md#retries-and-timeouts). Returns null when the
   * lane produced no telemetry; must never throw a run-failing error (the
   * caller logs and continues). The result lands in the run log, a
   * `::notice::`/`::warning::` annotation, and the PR-body table.
   */
  collectRetryTelemetry?: (params: { repositoryRoot: string }) => Promise<PreviewRetrySummary>;
};

/**
 * Aggregated retry telemetry for one app's preview e2e lane: every test that
 * needed a re-roll, whichever sub-lane (vitest, playwright specs) it ran in.
 * Why this exists: with one CI retry, a rare real race turns a run red about
 * once in 400 runs, but shows up here about once in 20 — the count, not the
 * run status, is the detector for probabilistic bugs.
 */
export type PreviewRetrySummary = {
  retried: {
    /** Which sub-lane observed the retry (e.g. "vitest", "specs"). */
    lane: string;
    name: string;
    retryCount: number;
    passedAfterRetry: boolean;
  }[];
};

/**
 * Where the os lane tells the vitest RetryTelemetryReporter (see
 * packages/shared test-support/e2e-policy) to write its JSON. The lane
 * removes the file before running so a previous run on the same machine
 * (marathon loops) can't leak stale telemetry.
 */
const osVitestRetryTelemetryFile = "/tmp/os-preview-vitest-retries.json";

/** Reads the JSON written by RetryTelemetryReporter (vitest sub-lane). */
async function readVitestRetryTelemetry(filePath: string): Promise<PreviewRetrySummary["retried"]> {
  const TelemetryFile = z.object({
    retried: z.array(
      z.object({
        fullName: z.string(),
        retryCount: z.number().int().positive(),
        passedAfterRetry: z.boolean(),
      }),
    ),
  });
  const parsed = TelemetryFile.parse(JSON.parse(await readFile(filePath, "utf8")));
  return parsed.retried.map((record) => ({
    lane: "vitest",
    name: record.fullName,
    retryCount: record.retryCount,
    passedAfterRetry: record.passedAfterRetry,
  }));
}

/**
 * Reads Playwright's JSON report (already written by the root
 * playwright.config.ts json reporter). A retried spec has more than one
 * result attempt; Playwright reports "flaky" for passed-after-retry.
 */
async function readPlaywrightRetryTelemetry(
  filePath: string,
): Promise<PreviewRetrySummary["retried"]> {
  /** The subset of Playwright's JSON-reporter suite tree we walk. */
  type PlaywrightJsonSuite = {
    suites?: PlaywrightJsonSuite[];
    specs?: {
      title?: string;
      tests?: { status?: string; results?: { retry?: number }[] }[];
    }[];
  };
  const report = JSON.parse(await readFile(filePath, "utf8")) as {
    suites?: PlaywrightJsonSuite[];
  };
  const retried: PreviewRetrySummary["retried"] = [];
  const visit = (suite: PlaywrightJsonSuite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const retryCount = Math.max(0, ...(test.results ?? []).map((result) => result.retry ?? 0));
        if (retryCount > 0) {
          retried.push({
            lane: "specs",
            name: spec.title ?? "(unknown spec)",
            retryCount,
            passedAfterRetry: test.status === "flaky",
          });
        }
      }
    }
    for (const child of suite.suites ?? []) {
      visit(child);
    }
  };
  for (const suite of report.suites ?? []) {
    visit(suite);
  }
  return retried;
}

/**
 * Reads one sub-lane's telemetry, treating a missing file as "no retries"
 * (the sub-lane may have died before writing) and logging anything else —
 * telemetry must never fail the lane.
 */
async function readRetryTelemetryLane(
  label: string,
  read: () => Promise<PreviewRetrySummary["retried"]>,
): Promise<PreviewRetrySummary["retried"]> {
  try {
    return await read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[preview] retry telemetry unreadable for ${label}:`, error);
    }
    return [];
  }
}

/** One compact human line for the run log and the PR-body table. */
function renderPreviewRetrySummary(summary: PreviewRetrySummary): string | null {
  if (summary.retried.length === 0) {
    return null;
  }
  const details = summary.retried
    .map(
      (record) =>
        `${record.name} (${record.lane} x${record.retryCount}${record.passedAfterRetry ? "" : ", still failed"})`,
    )
    .join(" · ");
  return `${summary.retried.length} retried: ${details}`;
}

/**
 * Surfaces retry telemetry as a workflow annotation, mirroring
 * warnIfOverBudget: one or two retried tests per run is the observed
 * platform-flake floor (~0.5% of test executions) and gets a notice; a
 * pile-up smells like a slot-wide problem and escalates to a warning.
 */
function announceRetryTelemetry(slug: string, summary: PreviewRetrySummary) {
  const rendered = renderPreviewRetrySummary(summary);
  if (!rendered) {
    return;
  }
  const level = summary.retried.length >= 4 ? "warning" : "notice";
  console.log(
    `::${level} title=Preview e2e retries::${slug}: ${rendered}. A retried test is a real failure a ` +
      `re-roll absorbed — see docs/testing.md#retries-and-timeouts.`,
  );
}

// Deployed apps compile in @iterate-com/shared via many subpath exports (streams,
// durable-object-utils, callable, codemode, config, evlog, ...), so trigger on the
// whole package rather than chasing individual subdirectories. Deploys are idempotent,
// so over-triggering is safe; under-triggering means prod silently misses deploys.
export const cloudflareAppSharedPaths = [
  "packages/shared/**",
  "packages/ui/**",
  "packages/mock-http-proxy/**",
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
  // The preview deploy + e2e + cleanup lifecycle is one Depot CI workflow.
  // Keep this in sync with that file's own `on.pull_request.paths` list: a
  // change to the workflow (or the shared preview orchestration) triggers a
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

/** Trigger preview workflow runs; apps here are not necessarily redeployed. */
export const cloudflarePreviewAdditionalTriggerPaths = [
  "apps/iterate-com/**",
  "apps/auth-example/**",
] as const;

export const cloudflarePreviewApps: Record<CloudflarePreviewAppSlug, CloudflarePreviewApp> = {
  os: {
    slug: "os",
    displayName: "OS",
    appPath: "apps/os",
    deployCommandArgs: ["pnpm", "run-script", "deploy"],
    destroyCommandArgs: ["pnpm", "run-script", "destroy"],
    dopplerProject: "os",
    // oRPC's /api/__internal/health is gone with the teardown — readiness now
    // probes the plain /api/health route that replaced it. Without this, the
    // preview deploy waits the full 10min readiness timeout on a 404 and fails.
    previewReadyUrlPath: "/api/health",
    paths: [
      "apps/os/**",
      "apps/auth/**",
      "apps/auth-contract/**",
      "apps/os/src/domains/streams/**",
    ],
    // OS bakes auth JWKS during deployment, so the slot's auth must deploy
    // whenever OS does. Deploys run in parallel: the OS deploy polls the
    // slot's auth worker for JWKS until it responds.
    previewDependencies: ["auth"],
    // Budgets sit ~25% above the observed green floor (deploy ~40s, e2e lane
    // ~60s as of 2026-07-02). Crossing them warns, never fails.
    previewDeployBudgetMs: 55_000,
    previewTestBudgetMs: 80_000,
    previewTestArtifacts: ["test-results", "apps/os/test-results", "/tmp/os-e2e-*"],
    previewTestBaseUrlEnvVar: "OS_BASE_URL",
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
        // Remove stale retry-telemetry files FIRST — before any step that can
        // exit the lane early (the smoke gate below). They survive from a
        // previous run on the same machine (marathon loops), and
        // collectRetryTelemetry runs pass or fail, so a leftover file would
        // report a previous run's retries against this one.
        `rm -f ${osVitestRetryTelemetryFile} ../../test-results/playwright-results.json`,
        // The chromium download hits no deployed slot, so start it first and
        // let it overlap the smoke and the vitest lane; it's ready by the
        // time we reach the specs instead of adding ~4s in front of them.
        "pnpm --dir ../.. exec playwright install chromium > /tmp/os-preview-pw-install.log 2>&1 & PW_INSTALL_PID=$!",
        // Create-saga smoke: one sequential real project create pays the
        // cold-start costs (cold DO chain, repo seed, worker probe) that
        // otherwise surface as rotating "saw 0 events" timeout flakes across
        // the concurrent e2e suites (see tasks/os-cold-create-latency.md),
        // and fails loudly if the slot is broken before the suites start.
        // The curl-round HTTP warmups that used to run alongside it were
        // treating symptoms of zombie routes (routes dead at the edge →
        // 522s) — structurally gone now that deploys never delete workers
        // (routes are declared in wrangler config; DNS is create-only).
        "pnpm exec tsx e2e/vitest/onboarding-smoke.ts > /tmp/os-preview-smoke.log 2>&1 & SMOKE_PID=$!",
        'wait "$SMOKE_PID" || { cat /tmp/os-preview-smoke.log; exit 1; }',
        // The e2e vitest lane and the Playwright specs hit the same slot but
        // provision independent projects, so they run concurrently: the vitest
        // lane in the background, the specs in the foreground. The vitest log
        // is replayed once the specs finish.
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
        // Retry telemetry: the vitest lane writes its retry JSON (stale
        // files were removed at the top of this script) for preview.ts to
        // fold into the PR body alongside Playwright's
        // playwright-results.json.
        `E2E_RETRY_TELEMETRY_FILE=${osVitestRetryTelemetryFile} timeout ${OS_PREVIEW_VITEST_LANE_TIMEOUT_SECS} pnpm e2e --project node > /tmp/os-preview-vitest.log 2>&1 & E2E_PID=$!`,
        'wait "$PW_INSTALL_PID" || { cat /tmp/os-preview-pw-install.log; exit 1; }',
        // Capture the specs' exit without aborting (set -e) so the vitest lane
        // always finishes and its log is replayed — a Playwright flake must not
        // hide (or orphan) the vitest results.
        "SPEC_OK=0; pnpm --dir ../.. spec || SPEC_OK=$?",
        'E2E_OK=0; wait "$E2E_PID" || E2E_OK=$?',
        "cat /tmp/os-preview-vitest.log",
        '[ "$E2E_OK" -eq 0 ] && [ "$SPEC_OK" -eq 0 ]',
      ].join("; "),
    ],
    collectRetryTelemetry: async ({ repositoryRoot }) => {
      const [vitest, specs] = await Promise.all([
        readRetryTelemetryLane("os vitest lane", () =>
          readVitestRetryTelemetry(osVitestRetryTelemetryFile),
        ),
        readRetryTelemetryLane("os playwright specs", () =>
          readPlaywrightRetryTelemetry(
            resolve(repositoryRoot, "test-results/playwright-results.json"),
          ),
        ),
      ]);
      return { retried: [...vitest, ...specs] };
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
    paths: ["apps/semaphore/**"],
    // Semaphore bakes the slot's auth JWKS at deploy time (relying-party
    // auth, same as OS), so the slot's auth must deploy whenever semaphore
    // does. Deploys run in parallel: the JWKS fetch polls until auth serves.
    previewDependencies: ["auth"],
    previewTestBaseUrlEnvVar: "SEMAPHORE_BASE_URL",
    // `env -u SEMAPHORE_API_TOKEN`: the CI lane runs under an outer
    // `doppler run --project _shared --config prd` whose SEMAPHORE_API_TOKEN
    // targets prd and leaks through into this nested env — never the right
    // credential for a preview slot. Unsetting it makes the e2e forge-mint a
    // slot-scoped admin token instead (scripts/auth/semaphore-token.ts).
    previewTestCommandArgs: ["env", "-u", "SEMAPHORE_API_TOKEN", "pnpm", "test:e2e:preview"],
  },
  // Every preview slot runs its own auth deployment (auth.iterate-preview-N.com)
  // so e2e starts from a completely clean, controlled slate. OAuth client
  // credentials are constants in Doppler (`preview provision-auth-preview-configs`);
  // the auth deploy reseeds them into its database on every run, so auth and
  // OS tests can run after both apps have finished deploying.
  auth: {
    slug: "auth",
    displayName: "Auth",
    appPath: "apps/auth",
    deployCommandArgs: ["pnpm", "run-script", "deploy"],
    destroyCommandArgs: ["pnpm", "run-script", "destroy"],
    dopplerProject: "auth",
    paths: ["apps/auth/**", "apps/auth-contract/**"],
    // better-auth's liveness endpoint; auth has no /api/__internal/health.
    previewReadyUrlPath: "/api/auth/ok",
    previewTestBaseUrlEnvVar: "AUTH_BASE_URL",
    previewTestCommandArgs: [
      "bash",
      "-c",
      'curl -fsS "$AUTH_BASE_URL/api/auth/.well-known/openid-configuration" | grep -q \'"authorization_endpoint"\'',
    ],
  },
  "streams-example-app": {
    slug: "streams-example-app",
    displayName: "Streams Example App",
    appPath: "apps/streams-example-app",
    deployCommandArgs: ["pnpm", "run-script", "deploy"],
    destroyCommandArgs: ["pnpm", "run-script", "destroy"],
    dopplerProject: "streams-example-app",
    paths: ["apps/streams-example-app/**", "apps/os/src/domains/streams/**"],
    previewTestBaseUrlEnvVar: "WORKER_URL",
    previewTestCommandArgs: [
      "bash",
      "-c",
      [
        // Deployed playgrounds are admin-only: the node vitest lane rides a
        // forge-minted admin bearer (e2e/auth.ts); Playwright signs itself in
        // via its global setup.
        'export STREAMS_PLAYGROUND_TOKEN="$(pnpm exec tsx e2e/auth.ts)"',
        "pnpm exec playwright install chromium & install_pid=$!",
        "STREAM_STAGING_E2E=true pnpm vitest -t @preview & vitest_pid=$!",
        "install_status=0",
        "vitest_status=0",
        'wait "$install_pid" || install_status=$?',
        'wait "$vitest_pid" || vitest_status=$?',
        'if [ "$install_status" -ne 0 ] || [ "$vitest_status" -ne 0 ]; then exit 1; fi',
        "pnpm playwright --grep @preview --reporter=list",
      ].join("; "),
    ],
  },
};

const cloudflarePreviewSectionLabel = "CLOUDFLARE_PREVIEW";
const cloudflarePreviewStateLabel = "CLOUDFLARE_PREVIEW_STATE";
const defaultSemaphoreBaseUrl = "https://semaphore.iterate.com";
const defaultRepositoryFullName = "iterate/iterate";
// A preview slot belongs to its PR for the PR's whole life: every `preview
// deploy` and `preview test` run renews the lease for this long, and closing
// the PR releases it. Expiry is only the safety valve for abandoned PRs — a
// PR that pushes nothing for this long may lose its slot to another PR.
// While a lease is live, nothing takes the slot without a human --force.
const defaultPreviewLeaseMs = 24 * 60 * 60 * 1000;
// Routed previews can be healthy before Cloudflare has finished issuing edge
// certificates for newly-created hostnames. Some apps record a separate
// project-subdomain URL; wait on that URL only when it is expected to be
// certificate-covered in the preview environment.
// https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/#full-setup
// https://developers.cloudflare.com/ssl/edge-certificates/additional-options/total-tls/
// Keep this long enough for first issuance of supported hostnames while still
// returning immediately once the health endpoint is reachable.
const defaultPreviewReadyTimeoutMs = 600_000;
const defaultPreviewReadyUrlPath = "/api/__internal/health";
/**
 * Whole-lane attempts for an app's preview test command. Pinned to 1 by the
 * retry policy (docs/testing.md#retries-and-timeouts): retries live in the
 * individual test; everything above only watches and fails. Exported so
 * e2e-policy.test.ts can guard the pin.
 */
export const defaultPreviewTestMaxAttempts = 1;
const defaultPreviewTestRetryDelayMs = 5_000;
const defaultPreviewDeployConcurrency = 5;
const ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE = "environment-config-lease" as const;
const previewEnvironmentSlotNumbers = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
// auth/preview root inherits these from auth/dev when it doesn't already carry
// its own value. All are canonical APP_CONFIG_* names (the AppConfig port,
// #1594); the pre-port legacy flat names are gone from every auth config.
const sharedAuthPreviewSecretsCopiedFromDev = [
  "APP_CONFIG_GOOGLE_CLIENT_ID",
  "APP_CONFIG_GOOGLE_CLIENT_SECRET",
  "APP_CONFIG_EMAIL_SENDER_DOMAIN",
  "APP_CONFIG_SIGNUP_ALLOWLIST",
] as const;

export const EnvironmentConfigLease = z.object({
  dopplerConfig: z.string().trim().min(1),
  leasedUntil: z.number().int().positive(),
  leaseId: z.string().uuid(),
  slug: z.string().trim().min(1),
  type: z.string().trim().min(1),
});

const CloudflarePreviewStatus = z.enum([
  "awaiting-tests",
  "claim-failed",
  "cleanup-failed",
  "deploy-failed",
  "deployed",
  "fork-unavailable",
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
  testDurationMs: z.number().nonnegative().finite().nullable().optional(),
  /** Rendered retry telemetry for the last test run (renderPreviewRetrySummary). */
  testRetries: z.string().trim().min(1).nullable().optional(),
});
export type CloudflarePreviewAppEntry = z.infer<typeof CloudflarePreviewAppEntry>;

const CloudflarePreviewState = z.object({
  apps: z.record(z.string().trim().min(1), CloudflarePreviewAppEntry).default({}),
  environmentConfigLease: EnvironmentConfigLease.nullable().default(null),
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

export type EnvironmentConfigLease = z.infer<typeof EnvironmentConfigLease>;
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
    holder?: string;
    leaseMs: number;
    type: string;
    waitMs?: number;
  }) => Promise<PreviewSemaphoreLease>;
  acquireSpecific: (input: {
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
    acquire: ({ holder, leaseMs, type, waitMs }) =>
      semaphore.resources.acquire({ holder, leaseMs, type, waitMs }),
    acquireSpecific: ({ force, holder, leaseMs, slug, type }) =>
      semaphore.resources.acquireSpecific({ force, holder, leaseMs, slug, type }),
    renew: ({ leaseId, leaseMs, slug, type }) =>
      semaphore.resources.renew({ leaseId, leaseMs, slug, type }),
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
      summary: state.environmentConfigLease
        ? renderEnvironmentConfigLeaseSummary(state.environmentConfigLease)
        : "No active environment config lease.",
      table,
    }),
    failureDetails || null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function renderEnvironmentConfigLeaseSummary(lease: EnvironmentConfigLease) {
  return [
    `Lease: ${lease.slug}`,
    `Doppler config: ${lease.dopplerConfig}`,
    `Type: ${lease.type}`,
    `Leased until: ${new Date(lease.leasedUntil).toISOString()}`,
  ].join(" | ");
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
    case "fork-unavailable":
      return "unavailable for forks";
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
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${input.apiToken}`,
    },
    signal: input.signal,
  });
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

async function ensureAuthPreviewConfigs(input: { rotate: boolean }) {
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

  // Semaphore and the streams playground are relying parties of each slot's
  // auth deployment: their deploys bake the forge public key into the JWKS,
  // and their e2e mints admin bearer tokens with the private half. Seed the
  // key once at each preview root so every preview_N branch config inherits
  // it.
  const forgePrivateJwk =
    getDopplerSecret("semaphore", "preview", "AUTH_FORGE_PRIVATE_JWK") ||
    getDopplerSecret("os", "preview", "AUTH_FORGE_PRIVATE_JWK");
  if (!forgePrivateJwk) throw new Error("os/preview is missing AUTH_FORGE_PRIVATE_JWK");
  setDopplerSecrets("semaphore", "preview", { AUTH_FORGE_PRIVATE_JWK: forgePrivateJwk });
  console.log("semaphore/preview root config ensured");
  setDopplerSecrets("streams-example-app", "preview", { AUTH_FORGE_PRIVATE_JWK: forgePrivateJwk });
  console.log("streams-example-app/preview root config ensured");

  for (const slot of previewEnvironmentSlotNumbers) {
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

    ensureDopplerConfig("auth", config);
    ensureDopplerConfig("semaphore", config);
    ensureDopplerConfig("streams-example-app", config);

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
      // readPreviewAppConfig reads APP_CONFIG_BASE_URL to learn the app's public
      // URL. Origins/routes themselves are generated from the root envs.ts.
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
      APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN: serviceToken,
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

    if (input.rotate) {
      clearAuthPreviewJwks({ config, slot });
    }

    console.log(
      `slot ${slot}: auth/${config} + os/${config} + semaphore/${config} + streams-example-app/${config} ensured (clients ${clientId}, ${semaphoreClientId}, ${streamsExampleClientId})`,
    );
  }

  console.log("done");
}

// Better Auth encrypts jwks rows with APP_CONFIG_BETTER_AUTH_SECRET; after a
// rotation the old rows can no longer be decrypted, so they must be cleared.
function clearAuthPreviewJwks(input: { config: string; slot: number }) {
  runDoppler([
    ...["run", "--project", "auth", "--config", input.config, "--"],
    ...["pnpm", "--dir", "apps/auth", "exec", "wrangler", "d1", "execute"],
    `auth-preview-${input.slot}-auth-db`,
    ...["--remote", "--command", "delete from jwks;"],
  ]);
  console.log(`slot ${input.slot}: cleared auth JWKS rows after Better Auth secret rotation`);
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

function ensureDopplerConfig(project: string, config: string) {
  const existing = runDoppler(["configs", "--project", project, "--json"]);
  const names = (JSON.parse(existing) as { name: string }[]).map((dopplerConfig) => {
    return dopplerConfig.name;
  });
  if (!names.includes(config)) {
    runDoppler(["configs", "create", config, "--project", project]);
    console.log(`created config ${project}/${config}`);
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
  const recordedLease = current.state.environmentConfigLease;
  if (recordedLease == null) {
    logPreview("PR body records no lease — nothing to tear down or release");
    return {
      ok: true,
      released: false,
      state: current.state,
    };
  }
  logPreview(
    `PR body records lease ${recordedLease.slug} (doppler config ${recordedLease.dopplerConfig}, recorded until ${formatUntil(recordedLease.leasedUntil)}) — verifying this PR still holds it before destroying anything`,
  );

  // Never destroy a slot this PR no longer holds: after a lease expires,
  // the slot (and the deployments on it) may belong to another PR now.
  const holder = pullRequestHolder(params.context.pullRequestNumber);
  const semaphore = params.createPreviewSemaphoreResourceClient();
  const reasserted = await reassertEnvironmentConfigLease({
    holder,
    lease: recordedLease,
    leaseMs: defaultPreviewLeaseMs,
    semaphore,
  });
  if (!reasserted.ok) {
    logPreview(`cleanup skipped: ${reasserted.message}`);
    const update = await updatePreviewState(params.context, (state) => ({
      ...state,
      environmentConfigLease: null,
      notice: `Teardown skipped: ${reasserted.message}`,
      apps: Object.fromEntries(
        Object.entries(state.apps).map(([appSlug, entry]) => [
          appSlug,
          {
            ...entry,
            status: "released" as const,
            message: `Teardown skipped: ${reasserted.message}`,
            updatedAt: new Date().toISOString(),
          },
        ]),
      ),
    }));
    return {
      ok: true,
      released: false,
      skippedTeardown: true,
      state: update.state,
    };
  }

  const environmentConfigLease = reasserted.lease;
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

  if (!ok) {
    return {
      ok: false,
      released: false,
      state: latestState,
    };
  }

  const released = await semaphore.release({
    type: environmentConfigLease.type,
    slug: environmentConfigLease.slug,
    leaseId: environmentConfigLease.leaseId,
  });
  logPreview(
    released.released
      ? `lease released: ${environmentConfigLease.slug} is free again`
      : `lease was already gone for ${environmentConfigLease.slug}`,
  );
  const update = await updatePreviewState(params.context, (state) => ({
    ...state,
    environmentConfigLease: null,
  }));

  return {
    ok: true,
    released: released.released,
    state: update.state,
  };
}

async function deployPreviewAppWithStatus(input: {
  app: PreviewAppRuntime;
  commandEnvironment: NodeJS.ProcessEnv;
  dopplerConfig: string;
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
  pullRequestHeadSha: string;
  repositoryRoot: string;
  runUrl: string | null;
  signal?: AbortSignal;
}) {
  const appConfig = await readPreviewAppConfig({
    app: input.app,
    commandEnvironment: input.commandEnvironment,
    dopplerConfig: input.dopplerConfig,
    signal: input.signal,
    repositoryRoot: input.repositoryRoot,
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

  const deployResult = await runPreviewDeployCommand({
    app: input.app,
    commandEnvironment: input.commandEnvironment,
    dopplerConfig: input.dopplerConfig,
    operation: "up",
    repositoryRoot: input.repositoryRoot,
    signal: input.signal,
  });
  if (deployResult.exitCode !== 0) {
    return CloudflarePreviewAppEntry.parse({
      ...baseEntry,
      message: commandFailureMessage(deployResult, "Preview deployment failed."),
      status: "deploy-failed",
    });
  }

  const readiness = await waitForPreviewAppReadiness({
    publicUrl: appConfig.baseUrl,
    readyUrlPath: input.app.previewReadyUrlPath,
    signal: input.signal,
    timeoutMs: defaultPreviewReadyTimeoutMs,
  });
  if (!readiness.ok) {
    return CloudflarePreviewAppEntry.parse({
      ...baseEntry,
      message: readiness.message,
      status: "deploy-failed",
    });
  }

  return CloudflarePreviewAppEntry.parse({
    ...baseEntry,
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
    "const config = {",
    "  baseUrl: process.env.APP_CONFIG_BASE_URL || appConfig.baseUrl || null,",
    "  projectHostnameBases: envBases.length > 0 ? envBases : Array.isArray(appConfig.projectHostnameBases) ? appConfig.projectHostnameBases.filter((entry) => typeof entry === 'string') : [],",
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
    throw new Error(commandFailureMessage(result, "Failed to read preview app config."));
  }

  const parsed = z
    .object({
      baseUrl: z.string().trim().url(),
      projectHostnameBases: z.array(z.string().trim().min(1)).default([]),
    })
    .parse(JSON.parse(result.stdout));
  return parsed;
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
const defaultSlotWaitTotalMs = 20 * 60 * 1000;
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
// idle means "that PR/person hasn't touched the slot in this window".
const defaultReclaimMinIdleHours = 6;

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

/** Pure verdict for one slot; `orphaned` beats `idle` beats `active`. */
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
    // The holder PR is closed, so its cleanup should have released the slot;
    // the lease only survives when that cleanup failed.
    return "orphaned";
  }
  if (input.holderPullRequestState === "unknown") {
    // The GitHub check failed, so we cannot rule out an open PR — never let a
    // transient API error downgrade a hold to reclaimable-without---force.
    return "active";
  }
  if (input.lastAcquiredAt !== null && input.now - input.lastAcquiredAt >= input.minIdleMs) {
    return "idle";
  }

  return "active";
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
 * Garbage-collect one orphaned lease: a slot held by a pr-N holder whose PR
 * is closed (its cleanup failed, or the lease would be gone). This is the one
 * case automation may take a live lease — the holder can never come back for
 * it, and GitHub confirms that before we touch anything.
 */
async function tryReclaimOrphanedEnvironmentConfigLease(input: {
  fetchPullRequestState: PullRequestStateFetcher | null;
  holder: string;
  leaseMs: number;
  semaphore: PreviewSemaphoreResourceClient;
}) {
  if (!input.fetchPullRequestState) {
    return null;
  }

  const report = await classifyEnvironmentConfigLeases({
    fetchPullRequestState: input.fetchPullRequestState,
    minIdleMs: Number.POSITIVE_INFINITY,
    semaphore: input.semaphore,
  });
  const orphans = report
    .filter((slot) => slot.verdict === "orphaned")
    .sort((left, right) => (left.lastUsedAt ?? "").localeCompare(right.lastUsedAt ?? ""));
  for (const orphan of orphans) {
    const lease = await input.semaphore.acquireSpecific({
      type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
      slug: orphan.slug,
      leaseMs: input.leaseMs,
      holder: input.holder,
      force: true,
    });
    if (lease) {
      logPreview(
        `reclaimed orphaned slot ${orphan.slug}: it was leased by ${orphan.holder ?? "unknown holder"} whose PR is closed (${orphan.pullRequestUrl ?? "no PR url"}) — their cleanup must have failed`,
      );
      return lease;
    }
  }

  return null;
}

/**
 * Acquire any free slot, queueing (via semaphore long-poll) while all slots
 * are leased. Orphaned leases (holder PR closed but cleanup failed) are
 * garbage-collected before waiting. Fails with the full holder table and
 * remediation steps once `waitTotalMs` elapses.
 */
async function acquireAnyEnvironmentConfigLease(input: {
  semaphore: PreviewSemaphoreResourceClient;
  fetchPullRequestState?: PullRequestStateFetcher | null;
  holder: string;
  leaseMs: number;
  onFirstWait?: (holderTable: string) => Promise<void>;
  waitTotalMs: number;
}) {
  const deadline = Date.now() + input.waitTotalMs;
  let attempt = 0;

  for (;;) {
    attempt += 1;
    const remainingMs = deadline - Date.now();
    // The first attempt returns immediately so orphan garbage collection runs
    // before any long-poll; later attempts queue on the semaphore in 5-minute
    // polls, re-checking for freshly orphaned slots between polls.
    const waitMs = attempt === 1 ? 0 : Math.max(0, Math.min(slotWaitPerAttemptMs, remainingMs));
    try {
      return await input.semaphore.acquire({
        type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
        leaseMs: input.leaseMs,
        waitMs,
        holder: input.holder,
      });
    } catch (error) {
      if (!isNoSlotAvailableError(error)) {
        throw error;
      }

      const reclaimed = await tryReclaimOrphanedEnvironmentConfigLease({
        fetchPullRequestState: input.fetchPullRequestState ?? null,
        holder: input.holder,
        leaseMs: input.leaseMs,
        semaphore: input.semaphore,
      });
      if (reclaimed) {
        return reclaimed;
      }
      if (attempt === 1 && input.fetchPullRequestState) {
        logPreview(
          "all slots leased and none are orphaned (every holder's PR is still open or the hold is manual)",
        );
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
            "Every slot is leased by an open PR or a manual hold. Options:",
            "  - re-run once a slot frees up (leases release when their PR closes)",
            "  - see which holds are idle or orphaned: doppler run --project _shared --config prd -- pnpm preview reclaim",
            "  - take an idle/orphaned slot back: doppler run --project _shared --config prd -- pnpm preview reclaim --slot N",
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
 * Claim a slot for a PR. Prefers the slot recorded in the PR body: renew it
 * if this PR still holds it, re-take it if the lease expired but nobody else
 * claimed it, and only otherwise fall back to acquiring a different slot.
 * Every transition is logged.
 */
async function claimEnvironmentConfigLease(input: {
  createPreviewSemaphoreResourceClient: () => PreviewSemaphoreResourceClient;
  fetchPullRequestState?: PullRequestStateFetcher | null;
  holder: string;
  leaseMs: number;
  onFirstWait?: (holderTable: string) => Promise<void>;
  previousEnvironmentConfigLease: EnvironmentConfigLease | null;
  waitTotalMs: number;
}) {
  const semaphore = input.createPreviewSemaphoreResourceClient();
  const previousLease = input.previousEnvironmentConfigLease;

  if (previousLease) {
    const reasserted = await reassertEnvironmentConfigLease({
      holder: input.holder,
      lease: previousLease,
      leaseMs: input.leaseMs,
      semaphore,
    });
    if (reasserted.ok) {
      return reasserted.lease;
    }

    logPreview(`slot lost: ${reasserted.message} Acquiring a different slot.`);
  }

  // A run can acquire a slot and get cancelled (cancel-in-progress on a rapid
  // push) before the lease lands in the PR body. The next run then sees "no
  // lease recorded" and would acquire a SECOND slot — the semaphore happily
  // leases one holder several slots, and the unrecorded one stays leased until
  // expiry, shrinking the fleet (observed 2026-07-04: pr-1634 and pr-1636 each
  // held two slots and every deploy queued for 20 minutes). Adopt any lease the
  // semaphore already attributes to this holder before acquiring a fresh one.
  const adopted = await adoptExistingHolderLease({
    holder: input.holder,
    leaseMs: input.leaseMs,
    semaphore,
  });
  if (adopted) {
    return adopted;
  }

  const lease = await acquireAnyEnvironmentConfigLease({
    semaphore,
    fetchPullRequestState: input.fetchPullRequestState,
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
 * Core of `preview assign`: keep/renew the recorded slot when it satisfies
 * the request, otherwise take the wanted slot (or any free one) and release
 * the previously-held lease so it doesn't stay claimed against a slot the PR
 * no longer records.
 */
async function assignEnvironmentConfigLease(input: {
  fetchPullRequestState?: PullRequestStateFetcher | null;
  force?: boolean;
  holder: string;
  leaseMs: number;
  recordedLease: EnvironmentConfigLease | null;
  semaphore: PreviewSemaphoreResourceClient;
  wantedSlug: string | null;
}): Promise<{
  lease: EnvironmentConfigLease;
  outcome: "kept" | "assigned" | "moved";
  changedFromSlug: string | null;
  previousLeaseReleased: boolean;
}> {
  let heldLease: EnvironmentConfigLease | null = null;
  if (input.recordedLease) {
    const reasserted = await reassertEnvironmentConfigLease({
      holder: input.holder,
      lease: input.recordedLease,
      leaseMs: input.leaseMs,
      semaphore: input.semaphore,
    });
    if (reasserted.ok) {
      heldLease = reasserted.lease;
      if (!input.wantedSlug || input.wantedSlug === reasserted.lease.slug) {
        return {
          lease: reasserted.lease,
          outcome: "kept",
          changedFromSlug: null,
          previousLeaseReleased: false,
        };
      }
    } else {
      logPreview(`recorded slot is gone: ${reasserted.message}`);
    }
  }

  let lease: EnvironmentConfigLease;
  if (input.wantedSlug) {
    if (input.force) {
      const currentHolder = await findEnvironmentConfigLeaseHolder(
        input.semaphore,
        input.wantedSlug,
      );
      if (currentHolder && currentHolder !== input.holder) {
        logPreview(
          `--force: evicting ${currentHolder} from ${input.wantedSlug}. Their deployment on the slot is now fair game.`,
        );
      }
    }

    const acquired = await input.semaphore.acquireSpecific({
      leaseMs: input.leaseMs,
      slug: input.wantedSlug,
      type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
      holder: input.holder,
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
    lease = toEnvironmentConfigLease(acquired);
  } else {
    // A human is asking right now — fail fast with the holder table instead
    // of queueing like CI does.
    lease = toEnvironmentConfigLease(
      await acquireAnyEnvironmentConfigLease({
        semaphore: input.semaphore,
        fetchPullRequestState: input.fetchPullRequestState,
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

  const previousSlug = input.recordedLease?.slug ?? null;
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

/**
 * Find a lease the semaphore already attributes to this holder and re-issue it
 * under a fresh leaseId (safe force: the slot is already ours). Heals the
 * acquire-then-cancelled gap where a lease exists server-side but was never
 * recorded in the PR body, so a holder never accumulates a second slot. The
 * recorded-but-unrenewable slug is deliberately NOT excluded: if the list
 * still attributes it to this holder, re-issuing our own lease is idempotent
 * and adopting beats leasing a second slot.
 */
async function adoptExistingHolderLease(input: {
  holder: string;
  leaseMs: number;
  semaphore: PreviewSemaphoreResourceClient;
}): Promise<EnvironmentConfigLease | null> {
  const resources = await input.semaphore.list({ type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE });
  const held = resources.filter(
    (resource) => resource.leaseState === "leased" && resource.holder === input.holder,
  );
  for (const resource of held) {
    const repaired = await input.semaphore.acquireSpecific({
      type: ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
      slug: resource.slug,
      leaseMs: input.leaseMs,
      holder: input.holder,
      force: true,
    });
    if (repaired) {
      logPreview(
        `lease adopted: the semaphore already had ${repaired.slug} leased to ${input.holder} ` +
          `(a previous run was cancelled before recording it); re-issued until ${formatUntil(repaired.expiresAt)}`,
      );
      return toEnvironmentConfigLease(repaired);
    }
  }
  return null;
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
 * Confirm this PR still holds its recorded lease before acting on the slot
 * (running e2e against it, or destroying its deployments). Renews when held;
 * re-takes an expired-but-free slot; refuses when the slot now belongs to
 * someone else.
 */
async function reassertEnvironmentConfigLease(input: {
  holder: string;
  lease: EnvironmentConfigLease;
  leaseMs: number;
  semaphore: PreviewSemaphoreResourceClient;
}): Promise<
  | { ok: true; lease: EnvironmentConfigLease }
  | { ok: false; currentHolder: string | null; message: string }
> {
  const renewed = await input.semaphore.renew({
    type: input.lease.type,
    slug: input.lease.slug,
    leaseId: input.lease.leaseId,
    leaseMs: input.leaseMs,
  });
  if (renewed) {
    logPreview(
      `lease renewed: ${renewed.slug} held by ${input.holder} until ${formatUntil(renewed.expiresAt)}`,
    );
    return { ok: true, lease: toEnvironmentConfigLease(renewed) };
  }

  const retaken = await input.semaphore.acquireSpecific({
    type: input.lease.type,
    slug: input.lease.slug,
    leaseMs: input.leaseMs,
    holder: input.holder,
  });
  if (retaken) {
    logPreview(
      `lease re-acquired: ${retaken.slug} had expired but was still free; ${input.holder} holds it again until ${formatUntil(retaken.expiresAt)}`,
    );
    return { ok: true, lease: toEnvironmentConfigLease(retaken) };
  }

  const currentHolder = await findEnvironmentConfigLeaseHolder(input.semaphore, input.lease.slug);
  if (currentHolder === input.holder) {
    // The slot is still ours — only the recorded leaseId is stale (a renewal's
    // leaseId never made it into the PR body). Re-issuing our own lease is not
    // stealing, so force is safe here.
    const repaired = await input.semaphore.acquireSpecific({
      type: input.lease.type,
      slug: input.lease.slug,
      leaseMs: input.leaseMs,
      holder: input.holder,
      force: true,
    });
    if (repaired) {
      logPreview(
        `lease repaired: ${repaired.slug} was already held by ${input.holder} under a different leaseId (stale PR body state); re-issued until ${formatUntil(repaired.expiresAt)}`,
      );
      return { ok: true, lease: toEnvironmentConfigLease(repaired) };
    }
  }

  const prUrl = holderPullRequestUrl(currentHolder);
  return {
    ok: false,
    currentHolder,
    message: [
      `Slot ${input.lease.slug} no longer belongs to ${input.holder}: it is now leased by ${currentHolder ?? "someone else"}${prUrl ? ` (${prUrl})` : ""}.`,
      `Their deployment has replaced this PR's apps on ${input.lease.dopplerConfig}.`,
    ].join(" "),
  };
}

async function selectPreviewAppsForPullRequest(input: {
  githubToken: string;
  previousState: CloudflarePreviewState;
  pullRequestBaseSha: string;
  pullRequestHeadSha: string;
  pullRequestNumber: number;
  repositoryFullName: string;
}) {
  const compareBaseSha = resolvePreviewCompareBaseSha(input);
  if (!compareBaseSha) {
    return [];
  }
  if (compareBaseSha === input.pullRequestHeadSha) {
    const retryApps = selectPreviewAppsNeedingRetry({
      previousState: input.previousState,
      pullRequestHeadSha: input.pullRequestHeadSha,
    });
    logPreview(
      retryApps.length > 0
        ? `head sha unchanged since the last run — retrying apps that didn't reach a green state: ${retryApps.map((app) => app.slug).join(", ")}`
        : "head sha unchanged since the last run and every app finished — nothing to retry",
    );
    return retryApps;
  }

  const octokit = new Octokit({ auth: input.githubToken });
  const [owner, repo] = splitRepositoryFullName(input.repositoryFullName);
  const comparison = await withGithubRetry("compareCommits", () =>
    octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${compareBaseSha}...${input.pullRequestHeadSha}`,
    }),
  );
  const changedFiles =
    comparison.data.files?.flatMap((file) => (file.filename ? [file.filename] : [])) ?? [];
  logPreview(
    `selecting apps by diff ${compareBaseSha.slice(0, 7)}...${input.pullRequestHeadSha.slice(0, 7)} (${changedFiles.length} changed files)`,
  );

  const sharedPathHit = changedFiles.find((filename) =>
    matchesPreviewPath(filename, cloudflarePreviewSharedPaths),
  );
  if (sharedPathHit) {
    logPreview(
      `shared preview infrastructure changed (${sharedPathHit}) — deploying ALL preview apps`,
    );
    return Object.values(cloudflarePreviewApps);
  }

  const selectedSlugs = new Set<CloudflarePreviewAppSlugType>();
  for (const app of Object.values(cloudflarePreviewApps)) {
    const hit = changedFiles.find((filename) => matchesPreviewPath(filename, app.paths));
    if (hit) {
      logPreview(`app ${app.slug} selected: ${hit} changed`);
      selectedSlugs.add(app.slug);
    }
  }

  const expanded = expandPreviewDependencies([...selectedSlugs]);
  for (const slug of expanded) {
    if (!selectedSlugs.has(slug)) {
      logPreview(`app ${slug} added as a dependency of the selected apps`);
    }
  }

  return expanded.map((slug) => cloudflarePreviewApps[slug]);
}

function selectPreviewAppsNeedingRetry(params: {
  previousState: CloudflarePreviewState;
  pullRequestHeadSha: string;
}) {
  // Failed state is retried regardless of which head produced it: a slot
  // whose deploy failed at an OLD head stays wedged if the next push's diff
  // doesn't select those apps (observed: an envs.ts-only fix push selected
  // nothing, deploy skipped "nothing to deploy", the test lane then skipped
  // its stale recorded apps and the whole check went GREEN on a slot with
  // three deploy-failed apps). awaiting-tests keeps its same-head guard: at
  // an old head it just means "an older deploy finished and its e2e never
  // ran", which the current head's normal diff selection supersedes.
  const retrySlugs = Object.values(params.previousState.apps)
    .filter(
      (entry) =>
        ["claim-failed", "deploy-failed", "tests-failed"].includes(entry.status) ||
        (entry.status === "awaiting-tests" && entry.headSha === params.pullRequestHeadSha),
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
  // One parallel batch. OS bakes auth JWKS during deployment, but its
  // deploy-time JWKS fetch polls the slot's auth worker until it responds
  // (apps/os/scripts/deploy.ts fetchJwksWithRetry), so it no longer needs the
  // auth deploy sequenced before it.
  return apps.length > 0 ? [[...apps]] : [];
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

async function waitForHttpReadiness(params: { signal?: AbortSignal; timeoutMs: number; url: URL }) {
  const deadline = Date.now() + params.timeoutMs;
  let lastFailure = "No response received yet.";

  while (Date.now() < deadline) {
    try {
      const status = await fetchReadinessStatus(params.url, params.signal);
      if (status >= 200 && status < 300) {
        return { ok: true as const };
      }

      lastFailure = `Readiness check returned ${status} for ${params.url.toString()}.`;
    } catch (error) {
      lastFailure = formatPreviewErrorMessage(error);
    }

    await sleep(1_000, params.signal);
  }

  return {
    message: `Timed out waiting for preview readiness at ${params.url.toString()}. ${lastFailure}`,
    ok: false as const,
  };
}

async function fetchReadinessStatus(url: URL, signal: AbortSignal | undefined): Promise<number> {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal,
    });
    return response.status;
  } catch (error) {
    if (!isDnsLookupError(error)) {
      throw error;
    }

    return await requestStatusWithDnsResolve(url, signal);
  }
}

async function requestStatusWithDnsResolve(url: URL, signal: AbortSignal | undefined) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported readiness URL protocol: ${url.protocol}`);
  }

  const addresses = await dns.resolve4(url.hostname);
  const address = addresses[0];
  if (!address) {
    throw new Error(`No A record found for ${url.hostname}`);
  }

  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  const resolvedUrl = new URL(url);
  resolvedUrl.hostname = address;

  return await new Promise<number>((resolve, reject) => {
    const req = request(
      resolvedUrl,
      {
        headers: { Host: url.host },
        method: "GET",
        servername: url.hostname,
        signal,
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        response.resume();
        response.on("end", () => resolve(statusCode));
      },
    );
    req.on("error", reject);
    req.end();
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
  assignEnvironmentConfigLease,
  claimEnvironmentConfigLease,
  classifyEnvironmentConfigLeases,
  classifyLeaseForReclaim,
  decideDraftPreviewPolicy,
  describeEnvironmentConfigLeases,
  evaluateCloudflareZoneCheck,
  holderPullRequestUrl,
  pullRequestHolder,
  reassertEnvironmentConfigLease,
  resolveSlotWaitTotalMs,
  expandPreviewDependencies,
  orderPreviewDeployBatches,
  parseCloudflarePreviewState,
  parseEnvironmentConfigLeaseData,
  readPlaywrightRetryTelemetry,
  readVitestRetryTelemetry,
  reconcileEnvironmentConfigLeaseResources,
  renderCloudflarePreviewPullRequestBody,
  renderPreviewRetrySummary,
  resolveAuthPreviewRootSecret,
  resolvePreviewCompareBaseSha,
  resolvePreviewReadinessUrls,
  selectPreviewAppsNeedingRetry,
  splitRepositoryFullName,
  syncPreviewInventory,
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

async function runCommandWithRetries(
  params: Parameters<typeof runCommand>[0] & {
    maxAttempts: number;
    retryDelayMs: number;
  },
) {
  let attempt = 1;
  let lastResult = await runCommand(params);

  while (attempt < params.maxAttempts && lastResult.exitCode !== 0) {
    console.error(
      `Command failed on attempt ${attempt}/${params.maxAttempts}. Retrying in ${params.retryDelayMs}ms...`,
    );
    await sleep(params.retryDelayMs, params.signal);
    attempt += 1;
    lastResult = await runCommand(params);
  }

  return lastResult;
}

async function sleep(ms: number, signal?: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    if (!signal) {
      return;
    }

    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new Error("Aborted"));
    };

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
