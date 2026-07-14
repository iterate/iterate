/**
 * One-release cutover for the retired OS -> auth shared token in preview.
 *
 * The order is security-critical:
 *   1. Drain preview checks that were already running at cutover time. The
 *      dispatch confirmation requires old queued runs to be cancelled first;
 *      epoch-aware runs queued behind this job's gate are safe to ignore.
 *   2. Force-acquire all nine environment leases under one attributable holder.
 *      This is the explicit, breaking maintenance operation; acquisition does
 *      not erase project data.
 *   3. Sequentially deploy auth then OS in every slot. The normal OS deploy's
 *      RPC smoke -> Worker revocation -> post-revocation smoke -> Doppler
 *      retirement sequence remains the only mutation path.
 *   4. Revoke/re-list every live binding and delete/re-read every source once
 *      more, then release all nine leases only after the whole fleet succeeds.
 *
 * The workflow running this script shares one temporary concurrency gate with
 * preview deploy and cleanup. A deployment-floor marker in that workflow stops
 * stale branches before they can roll Auth back ahead of a failing old OS
 * deploy. If migration fails after acquisition, the leases remain held until a
 * successful rerun or their bounded expiry.
 */
import { createSemaphoreClient } from "../../apps/semaphore/src/contract.ts";
import { envs, type DeployedEnv, type EnvName } from "../../envs.ts";
import { isMainModule } from "../../packages/shared/src/dev/is-main-module.ts";
import { createSemaphoreTokenProvider } from "../auth/semaphore-token.ts";
import {
  deleteDopplerSecretIfPresent,
  deleteWorkerSecretIfPresent,
  run,
} from "../lib/deploy-helpers.ts";
import { resolveEnvContext, type EnvContext } from "../lib/env-context.ts";
import { environmentConfigLeaseInventory, previewInternals } from "../preview/preview.ts";
import { getOctokit, getRepo } from "./github.ts";

const RETIRED_AUTH_SERVICE_TOKEN = "APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN";
const PREVIEW_CHECK_NAMES = new Set([
  "Cloudflare Previews (Depot CI) / Preview / deploy + e2e",
  "Cloudflare Preview Cleanup (Depot CI) / Preview / cleanup",
]);
const CUTOVER_HOLDER = "main-auth-rpc-security-cutover";
const CUTOVER_LEASE_MS = 3 * 60 * 60_000;
const CHECK_DRAIN_TIMEOUT_MS = 12 * 60_000;
const CHECK_DRAIN_POLL_MS = 5_000;
const GITHUB_RATE_LIMIT_MAX_ATTEMPTS = 5;
const GITHUB_RATE_LIMIT_MAX_DELAY_MS = 30_000;

export type PreviewFleetTarget = {
  envName: Extract<EnvName, `preview_${number}`>;
  slug: string;
};

export const previewFleetTargets = environmentConfigLeaseInventory.map((resource) => ({
  envName: resource.data.dopplerConfig as PreviewFleetTarget["envName"],
  slug: resource.slug,
})) satisfies PreviewFleetTarget[];

export type PreviewCheck = {
  id: number;
  name: string;
  status: string;
};

type GitHubRequestError = {
  status?: number;
  message?: string;
  response?: {
    headers?: Record<string, string | undefined>;
  };
};

function secondaryRateLimitDelayMs(error: unknown, attempt: number) {
  if (!error || typeof error !== "object") return undefined;
  const requestError = error as GitHubRequestError;
  if (requestError.status !== 403 && requestError.status !== 429) return undefined;

  const retryAfter = requestError.response?.headers?.["retry-after"];
  const isSecondaryLimit = requestError.message?.toLowerCase().includes("secondary rate limit");
  if (!isSecondaryLimit && retryAfter === undefined) return undefined;

  const retryAfterSeconds = Number(retryAfter);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(Math.max(1_000, retryAfterSeconds * 1_000), GITHUB_RATE_LIMIT_MAX_DELAY_MS);
  }
  return Math.min(2 ** (attempt - 1) * 1_000, GITHUB_RATE_LIMIT_MAX_DELAY_MS);
}

export async function withGitHubSecondaryRateLimitRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxAttempts?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const maxAttempts = options.maxAttempts ?? GITHUB_RATE_LIMIT_MAX_ATTEMPTS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delayMs = secondaryRateLimitDelayMs(error, attempt);
      if (delayMs === undefined || attempt === maxAttempts) throw error;
      console.warn(
        `GitHub secondary rate limit; retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxAttempts})`,
      );
      await sleep(delayMs);
    }
  }
  throw new Error("GitHub request retry loop exhausted without returning or throwing.");
}

export async function listPreviewChecksForRefs(input: {
  refs: Iterable<string>;
  listChecksForRef: (ref: string) => Promise<PreviewCheck[]>;
  sleep?: (ms: number) => Promise<void>;
}) {
  const checks: PreviewCheck[] = [];
  for (const ref of new Set(input.refs)) {
    checks.push(
      ...(await withGitHubSecondaryRateLimitRetry(() => input.listChecksForRef(ref), {
        sleep: input.sleep,
      })),
    );
  }
  return checks;
}

export type PreviewFleetMigrationDependencies = {
  acquireSlot: (target: PreviewFleetTarget) => Promise<{ leaseId: string }>;
  deployAuth: (target: PreviewFleetTarget) => Promise<void>;
  deployOs: (target: PreviewFleetTarget) => Promise<void>;
  drainLegacyPreviewChecks: () => Promise<void>;
  enforceRetirement: (target: PreviewFleetTarget) => Promise<void>;
  releaseSlot: (target: PreviewFleetTarget, leaseId: string) => Promise<void>;
};

async function forEveryTarget(
  action: string,
  operation: (target: PreviewFleetTarget) => Promise<void>,
) {
  const failures: Error[] = [];
  for (const target of previewFleetTargets) {
    try {
      await operation(target);
    } catch (error) {
      failures.push(
        new Error(`${action} failed for ${target.envName}`, {
          cause: error,
        }),
      );
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${action} failed for ${failures.length} preview slot(s).`);
  }
}

export async function migratePreviewFleet(dependencies: PreviewFleetMigrationDependencies) {
  await dependencies.drainLegacyPreviewChecks();
  const leases: Array<{ target: PreviewFleetTarget; leaseId: string }> = [];
  try {
    for (const target of previewFleetTargets) {
      const lease = await dependencies.acquireSlot(target);
      leases.push({ target, leaseId: lease.leaseId });
    }
  } catch (error) {
    // No code has moved yet, so unwind a partial fleet acquisition. Once the
    // first deployment starts, failures intentionally retain every lease.
    await Promise.all(
      leases.map(({ target, leaseId }) => dependencies.releaseSlot(target, leaseId)),
    );
    throw error;
  }

  for (const target of previewFleetTargets) {
    await dependencies.deployAuth(target);
    await dependencies.deployOs(target);
  }
  await forEveryTarget("final token retirement", dependencies.enforceRetirement);
  await forEveryTarget("cutover lease release", async (target) => {
    const lease = leases.find((candidate) => candidate.target.envName === target.envName);
    if (!lease) throw new Error(`No cutover lease was recorded for ${target.envName}.`);
    await dependencies.releaseSlot(target, lease.leaseId);
  });

  console.log(
    `preview auth RPC cutover complete: migrated and verified [${previewFleetTargets.map((target) => target.envName).join(", ")}]`,
  );
  return { migrated: previewFleetTargets.map((target) => target.envName) };
}

export function cutoverLeaseRequest(target: PreviewFleetTarget) {
  return {
    type: previewInternals.ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
    slug: target.slug,
    leaseMs: CUTOVER_LEASE_MS,
    holder: CUTOVER_HOLDER,
    force: true as const,
  };
}

export async function drainLegacyPreviewChecks(input: {
  listBlockingChecks: () => Promise<PreviewCheck[]>;
  readCheck: (id: number) => Promise<PreviewCheck>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
}) {
  const blocking = (await input.listBlockingChecks()).filter(
    (check) => PREVIEW_CHECK_NAMES.has(check.name) && check.status === "in_progress",
  );
  if (blocking.length === 0) {
    console.log("preview cutover drain: no pre-cutover checks are active");
    return;
  }

  console.log(
    `preview cutover drain: waiting for ${blocking.length} pre-cutover check(s): ${blocking.map((check) => `${check.name}#${check.id}`).join(", ")}`,
  );
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (input.timeoutMs ?? CHECK_DRAIN_TIMEOUT_MS);
  let pending = blocking;
  while (pending.length > 0) {
    if (now() >= deadline) {
      throw new Error(
        `Timed out draining pre-cutover preview checks: ${pending.map((check) => `${check.name}#${check.id}`).join(", ")}`,
      );
    }
    await sleep(input.pollMs ?? CHECK_DRAIN_POLL_MS);
    pending = (await Promise.all(pending.map((check) => input.readCheck(check.id)))).filter(
      (check) => check.status !== "completed",
    );
  }
  console.log("preview cutover drain: pre-cutover checks completed");
}

async function listRecentPreviewChecks(): Promise<PreviewCheck[]> {
  const octokit = getOctokit();
  const repo = getRepo();
  const openPulls = await withGitHubSecondaryRateLimitRetry(() =>
    octokit.paginate(octokit.rest.pulls.list, {
      ...repo,
      state: "open",
      per_page: 100,
    }),
  );
  const recentClosed = (
    await withGitHubSecondaryRateLimitRetry(() =>
      octokit.rest.pulls.list({
        ...repo,
        state: "closed",
        sort: "updated",
        direction: "desc",
        per_page: 100,
      }),
    )
  ).data;
  const headShas = [
    ...new Set([...openPulls, ...recentClosed].map((pullRequest) => pullRequest.head.sha)),
  ];
  return listPreviewChecksForRefs({
    refs: headShas,
    listChecksForRef: async (ref) => {
      const response = await octokit.rest.checks.listForRef({
        ...repo,
        ref,
        per_page: 100,
      });
      return response.data.check_runs.map((check) => ({
        id: check.id,
        name: check.name,
        status: check.status,
      }));
    },
  });
}

function createDependencies(): PreviewFleetMigrationDependencies {
  const semaphore = createSemaphoreClient({
    apiKey: createSemaphoreTokenProvider({
      baseUrl: "https://semaphore.iterate.com",
      email: "auth-rpc-cutover@iterate.com",
    }),
    baseURL: "https://semaphore.iterate.com",
  });
  const contexts = new Map<PreviewFleetTarget["envName"], EnvContext<DeployedEnv>>();

  const getContext = async (target: PreviewFleetTarget) => {
    const existing = contexts.get(target.envName);
    if (existing) return existing;
    const context = await resolveEnvContext({
      envs,
      dopplerProject: "os",
      env: target.envName,
    });
    contexts.set(target.envName, context);
    return context;
  };

  return {
    drainLegacyPreviewChecks: () => {
      const octokit = getOctokit();
      const repo = getRepo();
      return drainLegacyPreviewChecks({
        listBlockingChecks: listRecentPreviewChecks,
        readCheck: async (id) => {
          const response = await withGitHubSecondaryRateLimitRetry(() =>
            octokit.rest.checks.get({ ...repo, check_run_id: id }),
          );
          return {
            id: response.data.id,
            name: response.data.name,
            status: response.data.status,
          };
        },
      });
    },
    enforceRetirement: async (target) => {
      const context = await getContext(target);
      await deleteWorkerSecretIfPresent({
        cf: context.cf,
        workerName: context.env.osWorkerName,
        secretName: RETIRED_AUTH_SERVICE_TOKEN,
      });
      deleteDopplerSecretIfPresent({
        project: "os",
        config: context.env.dopplerConfig,
        secretName: RETIRED_AUTH_SERVICE_TOKEN,
      });
    },
    acquireSlot: async (target) => {
      const lease = await semaphore.resources.acquireSpecific(cutoverLeaseRequest(target));
      if (!lease) {
        throw new Error(`Semaphore did not force-acquire ${target.slug} for the cutover.`);
      }
      return lease;
    },
    deployAuth: async (target) => {
      run("pnpm", ["--dir", "apps/auth", "run-script", "deploy", "--env", target.envName], {
        cwd: process.cwd(),
      });
    },
    deployOs: async (target) => {
      run("pnpm", ["--dir", "apps/os", "run-script", "deploy", "--env", target.envName], {
        cwd: process.cwd(),
      });
    },
    releaseSlot: async (target, leaseId) => {
      const released = await semaphore.resources.release({
        type: previewInternals.ENVIRONMENT_CONFIG_LEASE_RESOURCE_TYPE,
        slug: target.slug,
        leaseId,
      });
      if (!released.released) {
        throw new Error(`Semaphore did not release the cutover lease for ${target.slug}.`);
      }
    },
  };
}

if (isMainModule(import.meta.url)) {
  await migratePreviewFleet(createDependencies());
}
