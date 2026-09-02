/**
 * Deploy apps/os to a deployed environment:
 *
 *   pnpm run deploy --env preview_3
 *   pnpm run deploy --env prd
 *
 * Runs the shared pipeline (scripts/lib/deploy-app.ts). Steps, all fail-fast:
 *   1. Verify the env's Doppler config carries every required secret, bake
 *      the static auth JWKS (issuer keys + forge public key), and validate
 *      the exact runtime config with the worker's own zod schema — a config
 *      that would throw on every request fails HERE, not after shipping.
 *   2. `vite build` with CLOUDFLARE_ENV=<env>, so the build output's
 *      wrangler.json is flattened for that env (name, routes, bindings).
 *      vite.config.ts regenerates wrangler.jsonc from envs.ts before the
 *      cloudflare plugin reads it — the build always sees a fresh config.
 *   3. `wrangler deploy --config <built config> --secrets-file <doppler>` —
 *      secrets land atomically in the same version as the code, and the
 *      config's declarative Durable Object `exports` are reconciled
 *      server-side in the same upload (a brand-new env, a parked slot and a
 *      steady-state redeploy are all the same single command).
 *   4. Smoke-probe the deployed base URL; exit nonzero unless the env is
 *      actually serving.
 *   5. Before touching any deployed resource, delete retired secret bindings
 *      still carried by the live Worker (deploy scripts are their only
 *      writer, so lingering ones are just stale deploys — verified removed)
 *      and assert the removed auth service token is absent from Doppler
 *      (human-edited: fail closed). After deploy, force an uncached
 *      project-directory lookup through AUTH.
 *
 * The worker script is never deleted and routes are ensure-only, so a deploy
 * can never strand the env's hostnames (the old zombie-route/522 class).
 */
import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { z } from "zod";
import { envs, type DeployedEnv } from "../../../envs.ts";
import { bakeStaticAuthJwks } from "../../../scripts/lib/bake-auth-jwks.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";
import {
  assertDopplerSecretAbsent,
  removeWorkerSecrets,
  runAsync,
  smokeResponse,
} from "../../../scripts/lib/deploy-helpers.ts";
import { ensureContainerClasses } from "../../../scripts/lib/do-reset.ts";
import { parseConfig } from "../src/config.ts";
import { templateIterateRepoPkgSpecs } from "../src/domains/repos/project-repo-seed.ts";
import { pinIterateRepoPkgRef } from "../src/pkg-pr-new.ts";
import {
  SANDBOX_INSTANCE_TYPE_BINDINGS,
  SANDBOX_INSTANCE_TYPES,
} from "../src/domains/sandboxes/instance-types.ts";
import {
  COMPATIBILITY_DATE,
  envShapedVars,
  OPTIONAL_SECRETS,
  REQUIRED_SECRETS,
  RETIRED_AUTH_SERVICE_TOKEN,
  RETIRED_WORKER_SECRETS,
  writeWranglerConfig,
} from "./generate-wrangler-config.ts";
import { ensureR2Bucket } from "./ensure-resources.ts";
import { ensureInboundEmailRouting } from "./email-routing-resources.ts";

const PREVIEW_PETSHOP_CONFIG = "APP_CONFIG_INTEGRATIONS__PETSHOP";
const PREVIEW_PACKAGE_AVAILABILITY_TIMEOUT_MS = 120_000;
const PREVIEW_PACKAGE_POLL_MS = 1_000;
const PREVIEW_PACKAGE_REQUEST_TIMEOUT_MS = 10_000;
const RETIRED_QUEUE_PAGE_SIZE = 100;
const RETIRED_WORKER_QUEUE_CONSUMERS = [
  { label: "Artifact event", suffix: "-events" },
  { label: "AI Search index-write", suffix: "-search-index-writes" },
] as const;

const RetiredQueue = z.object({
  queue_id: z.string(),
  queue_name: z.string(),
});
const RetiredQueueConsumer = z.object({
  consumer_id: z.string(),
  script: z.string().optional(),
  script_name: z.string().optional(),
  type: z.string().optional(),
});

/**
 * Every pkg.pr.new URL a preview pinned to `ref` will install: the config
 * repo template's iterate/iterate specs (project-repo-seed.ts scans the
 * manifests — name-agnostic, so template packages come and go without deploy
 * changes), each with its `@<ref>` swapped for the pinned SHA.
 */
export function pinnedPackageSpecsToAwait(ref: string): string[] {
  return templateIterateRepoPkgSpecs().map((spec) => pinIterateRepoPkgRef(spec, ref)!);
}

/**
 * pkg.pr.new publishes a PR head in a separate GitHub Actions workflow. The
 * Depot preview can start first, so make each exact immutable tarball an
 * explicit deployment prerequisite. This runs beside the Vite build and
 * sidecar uploads; the healthy path adds no critical-path work.
 */
export async function waitForPinnedPackage(
  packageSpec: string,
  dependencies: {
    fetch?: typeof fetch;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const fetchPackage = dependencies.fetch || fetch;
  const now = dependencies.now || Date.now;
  const sleep =
    dependencies.sleep ||
    (async (ms: number) => await new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = dependencies.timeoutMs ?? PREVIEW_PACKAGE_AVAILABILITY_TIMEOUT_MS;
  const deadline = now() + timeoutMs;
  let lastFailure = "No response received.";

  while (now() < deadline) {
    try {
      const response = await fetchPackage(packageSpec, {
        cache: "no-store",
        method: "HEAD",
        redirect: "follow",
        signal: AbortSignal.timeout(
          Math.max(1, Math.min(PREVIEW_PACKAGE_REQUEST_TIMEOUT_MS, deadline - now())),
        ),
      });
      if (response.ok) {
        console.log(`preview package available: ${packageSpec}`);
        return;
      }
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }

    await sleep(Math.min(PREVIEW_PACKAGE_POLL_MS, Math.max(0, deadline - now())));
  }

  throw new Error(
    `Timed out waiting ${timeoutMs}ms for the preview package ${packageSpec}. Last check: ${lastFailure}. The pkg.pr.new GitHub Actions publish must succeed before this preview can deploy.`,
  );
}

/**
 * Cloudflare refuses a handler-less Worker upload while a previous Queue
 * consumer still targets that script. Detach only the exact consumers left
 * behind by retired features; later deploys are read-only no-ops. The queues
 * themselves are deliberately left for separately audited resource cleanup.
 */
export async function detachRetiredWorkerQueueConsumers(input: {
  cf: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
  workerName: string;
}): Promise<Array<{ queueName: string; status: "absent" | "detached" }>> {
  const retiredQueues = RETIRED_WORKER_QUEUE_CONSUMERS.map(({ label, suffix }) => ({
    label,
    queueName: `${input.workerName}${suffix}`,
  }));
  const queueNames = new Set(retiredQueues.map(({ queueName }) => queueName));
  const queuesByName = new Map<string, z.infer<typeof RetiredQueue>>();
  for (let page = 1; queuesByName.size < queueNames.size; page += 1) {
    const queues = z
      .array(RetiredQueue)
      .parse(await input.cf(`/queues?per_page=${RETIRED_QUEUE_PAGE_SIZE}&page=${page}`));
    for (const queue of queues) {
      if (queueNames.has(queue.queue_name)) queuesByName.set(queue.queue_name, queue);
    }
    if (queues.length < RETIRED_QUEUE_PAGE_SIZE) break;
  }

  return Promise.all(
    retiredQueues.map(async ({ label, queueName }) => {
      const queue = queuesByName.get(queueName);
      if (!queue) {
        console.log(`retired ${label} Queue absent: ${queueName}`);
        return { queueName, status: "absent" } as const;
      }

      const consumers = z
        .array(RetiredQueueConsumer)
        .parse(await input.cf(`/queues/${encodeURIComponent(queue.queue_id)}/consumers`));
      const consumer = consumers.find(
        (candidate) =>
          candidate.type === "worker" &&
          (candidate.script === input.workerName || candidate.script_name === input.workerName),
      );
      if (!consumer) {
        console.log(`retired ${label} Queue consumer absent: ${queueName}`);
        return { queueName, status: "absent" } as const;
      }

      await input.cf(
        `/queues/${encodeURIComponent(queue.queue_id)}/consumers/${encodeURIComponent(consumer.consumer_id)}`,
        { method: "DELETE" },
      );
      console.log(`detached retired ${label} Queue consumer: ${queueName} -> ${input.workerName}`);
      return { queueName, status: "detached" } as const;
    }),
  );
}

/** Preview OS always runs its first-party integration proof against the
 * sibling dummy Petshop. Keep the formerly optional deployment setting from
 * drifting out of a slot and turning that proof into a runtime 401. */
export function assertPreviewPetshopIntegrationConfigured(
  envName: string,
  secrets: Record<string, string | undefined>,
) {
  if (envName.startsWith("preview_") && !secrets[PREVIEW_PETSHOP_CONFIG]?.trim()) {
    throw new Error(
      `${envName} requires ${PREVIEW_PETSHOP_CONFIG} so OS preview e2e can exercise the deployed dummy Petshop.`,
    );
  }
}

/** Production-only PostHog build credentials; never shipped as Worker bindings. */
export function posthogBuildEnv(
  envName: string,
  secrets: Record<string, string | undefined>,
): Record<string, string> {
  if (envName !== "prd") return {};
  return {
    POSTHOG_PERSONAL_API_KEY: requiredBuildSecret(secrets, "POSTHOG_PERSONAL_API_KEY"),
    POSTHOG_PROJECT_ID: requiredBuildSecret(secrets, "POSTHOG_PROJECT_ID"),
  };
}

function requiredBuildSecret(secrets: Record<string, string | undefined>, name: string) {
  const value = secrets[name]?.trim();
  if (!value) throw new Error(`${name} is required to upload OS source maps`);
  return value;
}

function osSmokes(env: DeployedEnv) {
  return [
    {
      url: `${env.baseUrl}/`,
      ok: (status: number) => status === 200 || (status >= 300 && status < 400),
      label: "dashboard",
    },
    {
      url: `${env.eventDocsBaseUrl}/`,
      ok: (status: number) => status === 200,
      label: "event docs",
    },
    { url: `${env.baseUrl}/api`, ok: (status: number) => status < 500, label: "os api" },
  ];
}

/**
 * The post-deploy auth Workers RPC proof predicate: only the exact OS
 * project-miss answer counts — status 404 with the JSON body
 * `{"error":"not found"}`. A fresh hostname cannot hit KV or the isolate's
 * short negative memo, so this body proves ingress reached
 * getProjectBySlug() on auth's default RPC entrypoint; an edge/router 404
 * (any other body) must fail the deploy. Exported narrowly for the
 * security-kernel test in deploy.test.ts.
 */
export async function isExactOsProjectMiss(response: Response): Promise<boolean> {
  if (response.status !== 404) return false;
  const body: unknown = await response.json().catch(() => null);
  return typeof body === "object" && body !== null && "error" in body && body.error === "not found";
}

/**
 * Preview orchestration may explicitly skip an unchanged container rollout.
 * Direct and production deploys stay on Wrangler's full-rollout default, and
 * a first-time class bootstrap always overrides the optimization.
 */
export function resolveOsContainerDeployArgs(input: {
  bootstrapAction: "bootstrapped" | "skipped";
  requestedRollout: string | undefined;
}): string[] | undefined {
  const requestedRollout = input.requestedRollout?.trim();
  if (
    requestedRollout !== undefined &&
    requestedRollout !== "" &&
    requestedRollout !== "immediate" &&
    requestedRollout !== "none"
  ) {
    throw new Error(
      `OS_CONTAINERS_ROLLOUT must be "immediate" or "none", got ${JSON.stringify(requestedRollout)}.`,
    );
  }

  return requestedRollout === "none" && input.bootstrapAction === "skipped"
    ? ["--containers-rollout", "none"]
    : undefined;
}

async function smokeAuthRpc(env: DeployedEnv, label: string) {
  const projectHostnameBase = env.projectHostnameBases[0];
  if (!projectHostnameBase) {
    throw new Error(`Cannot smoke AUTH RPC for ${env.osWorkerName}: no project hostname base.`);
  }

  const slug = `auth-rpc-smoke-${crypto.randomUUID().replaceAll("-", "")}`;
  const url = `https://${slug}.${projectHostnameBase}/`;
  await smokeResponse(url, isExactOsProjectMiss, label);
}

/** Deploy apps/os to a deployed environment (see scripts/lib/deploy-app.ts for the pipeline). */
export default async function deploy(
  options: {
    /** Target environment name from envs.ts (falls back to DOPPLER_CONFIG in CI). */
    env?: string;
  } = {},
) {
  // The preview orchestrator asks to skip Wrangler's six serial stock-image
  // builds only after proving their inputs unchanged from this slot's exact
  // prior deployment. Direct/prod deploys and first-time bootstraps retain the
  // full rollout. See resolvePreviewOsContainerRollout in preview.ts.
  let containerDeployArgs: string[] | undefined;

  await deployApp({
    appRoot: fileURLToPath(new URL("..", import.meta.url)),
    appLabel: "apps/os",
    envs,
    dopplerProject: "os",
    env: options.env,
    workerName: (env) => env.osWorkerName,
    servingUrl: (env) => env.baseUrl,
    resources: (env) => env.resources,
    requiredSecrets: REQUIRED_SECRETS,
    optionalSecrets: OPTIONAL_SECRETS,
    buildEnv: (ctx) => posthogBuildEnv(ctx.name, ctx.secrets),
    prepare: async (ctx, secretValues) => {
      // Doppler is human-edited, so a retired secret reappearing there is
      // config drift that needs a human: fail closed, never auto-fix.
      assertDopplerSecretAbsent({
        project: "os",
        config: ctx.env.dopplerConfig,
        secretName: RETIRED_AUTH_SERVICE_TOKEN,
        secrets: ctx.secrets,
      });
      // Worker secrets have exactly one writer — this deploy pipeline (and
      // the erase/handover flows). Omitted secrets survive `--secrets-file`
      // uploads, so the only way a retired name can linger is a Worker last
      // deployed by older code; deleting it here (loudly, verified) converges
      // every deploy to the current contract. An assert instead of a delete
      // proved sticky for previews: a lease RENEWAL deliberately skips the
      // erase-on-acquire, and each failed deploy renews the lease, so a slot
      // carrying a retired binding could never reach the erase that would
      // have healed it.
      await removeWorkerSecrets({
        cf: ctx.cf,
        workerName: ctx.env.osWorkerName,
        secretNames: RETIRED_WORKER_SECRETS,
      });

      // Derive Auth's public key locally from the shared Doppler private key.
      // The private half never ships to OS, and this deploy never waits on Auth.
      secretValues.APP_CONFIG_ITERATE_AUTH__JWKS = bakeStaticAuthJwks({
        envName: ctx.name,
        dopplerConfig: ctx.env.dopplerConfig,
        secrets: ctx.secrets,
      });

      // Sha-pin the template's iterate/iterate pkg.pr.new specs so project
      // seeds and every dynamic build install exact immutable tarballs
      // instead of the moving @main/@<pr> refs. Preview deploys pass their PR
      // head sha (scripts/preview/preview.ts) so e2e exercises the branch
      // tip; prd deploys pass their own main commit (deploy-os.yml) so live
      // config repos build in lockstep with the deployed platform — a
      // mutable @main is also CACHED by the dynamic worker host, which left
      // the iterate project building against a stale package for hours on
      // 2026-09-02 ("the installed 'iterate' package does not provide this
      // entry") while the stale worker kept serving. The pkg-pr-new GHA
      // workflow publishes every first-party package under the commit sha on
      // every push (PRs and main alike), and the pinned URLs are awaited as
      // deployment prerequisites below. Unset for dev/local deploys, where no
      // sha build exists for uncommitted state.
      const pinnedHeadSha =
        process.env.PREVIEW_PULL_REQUEST_HEAD_SHA || process.env.PLATFORM_DEPLOY_HEAD_SHA;
      if (pinnedHeadSha) {
        secretValues.APP_CONFIG_ITERATE_REPO_PKG_REF = pinnedHeadSha;
      }

      assertPreviewPetshopIntegrationConfigured(ctx.name, secretValues);

      // Parse the exact env the worker will see (secrets + generated vars) with
      // the worker's own schema — the strongest possible pre-flight.
      parseConfig({ ...secretValues, ...envShapedVars(ctx.env) });

      // Removing the queue binding and handler from source is insufficient for
      // an existing deployment: Cloudflare retains its consumer and rejects
      // the handler-less upload. This exact, idempotent detach is the rollout
      // migration; it never creates or reconciles subscriptions.
      await detachRetiredWorkerQueueConsumers({
        cf: ctx.cf,
        workerName: ctx.env.osWorkerName,
      });

      // Same rationale for R2: wrangler validates bucket bindings at upload,
      // and the files bucket is new — existing envs (previews, prd) get it
      // created here on their next deploy instead of a manual
      // ensure-resources run per environment.
      await ensureR2Bucket(ctx.cf, `${ctx.env.osWorkerName}-files`);
      // Sandbox container classes must exist container-enabled BEFORE the
      // exports deploy — the exports reconciliation can't enable namespaces
      // it creates (upstream gap; see ensureContainerClasses). Makes
      // brand-new environments deployable from scratch; no-op everywhere
      // else.
      const containerBootstrap = await ensureContainerClasses({
        ctx,
        workerName: ctx.env.osWorkerName,
        containerClassNames: SANDBOX_INSTANCE_TYPES.map(
          (instanceType) => SANDBOX_INSTANCE_TYPE_BINDINGS[instanceType].className,
        ),
        compatibilityDate: COMPATIBILITY_DATE,
      });
      containerDeployArgs = resolveOsContainerDeployArgs({
        bootstrapAction: containerBootstrap.action,
        requestedRollout: process.env.OS_CONTAINERS_ROLLOUT,
      });
      if (
        process.env.OS_CONTAINERS_ROLLOUT?.trim() === "none" &&
        containerBootstrap.action === "bootstrapped"
      ) {
        console.log(
          "container-class bootstrap created missing classes — running Wrangler's full container rollout",
        );
      }

      // Materialize the sidecar config before the independent build lane
      // starts. The main Vite build also regenerates this file, but doing it
      // here avoids racing that write with the sidecar's Wrangler process.
      writeWranglerConfig();
    },
    extraDeployArgs: () => containerDeployArgs,
    // Deploy the compiler sidecars while the OS Vite build runs. Keep their
    // Cloudflare uploads sequential within this lane: Wrangler makes several
    // API calls per upload, and running both together on top of the parallel
    // preview fleet has produced account-level 429s. Both still fit beneath
    // the main build, and deployApp joins this lane before uploading the main
    // Worker so neither service binding can target a missing script.
    concurrentBuildWork: async (ctx, secretValues, credentials) => {
      const cwd = fileURLToPath(new URL("..", import.meta.url));
      const tasks = [
        (async () => {
          for (const config of ["wrangler.typechecker.jsonc", "wrangler.worker-bundler.jsonc"]) {
            await runAsync(
              "pnpm",
              ["exec", "wrangler", "deploy", "--config", config, "--env", ctx.name],
              {
                cwd,
                env: credentials,
              },
            );
          }
        })(),
      ];
      const pinnedPkgRef = secretValues.APP_CONFIG_ITERATE_REPO_PKG_REF;
      if (pinnedPkgRef) {
        tasks.push(
          ...pinnedPackageSpecsToAwait(pinnedPkgRef).map((spec) => waitForPinnedPackage(spec)),
        );
      }

      const results = await Promise.allSettled(tasks);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          "Compiler-sidecar deployment and pinned package preflight both failed",
        );
      }
    },
    smokes: osSmokes,
    afterDeploy: async (ctx) => {
      await ensureInboundEmailRouting(ctx, {
        projectHostnameBases: ctx.env.projectHostnameBases,
        workerName: ctx.env.osWorkerName,
        workerRequirement: "require-deployed-worker",
      });
      await smokeAuthRpc(ctx.env, "auth Workers RPC");
    },
  });
}

void createCli({ ...import.meta, name: "deploy" }).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});
