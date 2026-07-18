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
 *   5. Before touching any deployed resource, assert that retired secret
 *      bindings are absent from the live Worker and that the removed auth
 *      service token is absent from Doppler too. After deploy, force an
 *      uncached project-directory lookup through AUTH.
 *
 * Worker scripts are never deleted and routes are ensure-only, so a deploy
 * can never strand the env's hostnames. New container classes live on
 * dedicated sidecars still eligible for legacy bootstrap when the main
 * worker's one-way exports set cannot grow.
 */
import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { envs, type DeployedEnv } from "../../../envs.ts";
import { bakeStaticAuthJwks } from "../../../scripts/lib/bake-auth-jwks.ts";
import { deployApp, runTimedDeployPhase } from "../../../scripts/lib/deploy-app.ts";
import {
  assertDopplerSecretAbsent,
  assertWorkerSecretAbsent,
  runAsync,
  smokeResponse,
} from "../../../scripts/lib/deploy-helpers.ts";
import { ensureContainerClasses } from "../../../scripts/lib/do-reset.ts";
import { parseConfig } from "../src/config.ts";
import { UNVERSIONED_WORKER_BUILD_DEPLOYMENT_ID } from "../src/domains/workers/worker-build-contract.ts";
import { cloudflareContainerApplicationName } from "../src/lib/cloudflare-containers-dashboard-url.ts";
import {
  OS_CONTAINER_CLASS_NAMES,
  workerBuilderWorkerName,
  WORKER_BUILDER_CONTAINER_CLASS_NAME,
} from "./container-class-names.ts";
import {
  COMPATIBILITY_DATE,
  envShapedVars,
  OPTIONAL_SECRETS,
  REQUIRED_SECRETS,
  RETIRED_AUTH_SERVICE_TOKEN,
  RETIRED_WORKER_SECRETS,
  workerBuildDeploymentId,
  writeWranglerConfig,
} from "./generate-wrangler-config.ts";
import { waitForContainerRollouts } from "./container-rollout-readiness.ts";
import { ensureWorkerQueues } from "./event-queue-resources.ts";
import { ensureR2Bucket } from "./ensure-resources.ts";
import { seedTemplateWorkerArtifact } from "./lib/seed-template-worker-artifact.ts";

const PREVIEW_PETSHOP_CONFIG = "APP_CONFIG_INTEGRATIONS__PETSHOP";
const OS_DEPLOY_LABEL = "apps/os";
const OS_APP_ROOT = fileURLToPath(new URL("..", import.meta.url));

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

/** Build-only PostHog credentials: available to Vite, never shipped as Worker bindings. */
export function posthogBuildEnv(secrets: Record<string, string | undefined>) {
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

async function smokeAuthRpc(env: DeployedEnv, label: string) {
  const projectHostnameBase = env.projectHostnameBases[0];
  if (!projectHostnameBase) {
    throw new Error(`Cannot smoke AUTH RPC for ${env.osWorkerName}: no project hostname base.`);
  }

  const slug = `auth-rpc-smoke-${crypto.randomUUID().replaceAll("-", "")}`;
  const url = `https://${slug}.${projectHostnameBase}/`;
  await smokeResponse(url, isExactOsProjectMiss, label);
}

function containerApplicationName(input: { className: string; workerName: string }): string {
  const applicationName = cloudflareContainerApplicationName(input);
  if (!applicationName) {
    throw new Error(`Cannot derive a Container application name for ${input.workerName}.`);
  }
  return applicationName;
}

function previewContainerApplicationNames(env: DeployedEnv): string[] {
  return [
    ...OS_CONTAINER_CLASS_NAMES.map((className) => ({
      className,
      workerName: env.osWorkerName,
    })),
    {
      className: WORKER_BUILDER_CONTAINER_CLASS_NAME,
      workerName: workerBuilderWorkerName(env.osWorkerName),
    },
  ].map(containerApplicationName);
}

/** Best-effort read used only to avoid redeploying an identical route-less
 * builder. A miss is observable and safely falls back to a normal deploy. */
export async function readWorkerBuilderDeploymentId(
  baseUrl: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await fetchImplementation(new URL("/api/health", baseUrl), {
      headers: { "cache-control": "no-cache" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("workerBuildDeploymentId" in body)) {
      return null;
    }
    const deploymentId = body.workerBuildDeploymentId;
    return typeof deploymentId === "string" && deploymentId.trim() ? deploymentId : null;
  } catch {
    return null;
  }
}

/** Deploy apps/os to a deployed environment (see scripts/lib/deploy-app.ts for the pipeline). */
export default async function deploy(
  options: {
    /** Target environment name from envs.ts (falls back to DOPPLER_CONFIG in CI). */
    env?: string;
  } = {},
) {
  const desiredWorkerBuildDeploymentId = workerBuildDeploymentId();
  let reuseWorkerBuilder = false;
  await deployApp({
    appRoot: OS_APP_ROOT,
    appLabel: OS_DEPLOY_LABEL,
    envs,
    dopplerProject: "os",
    env: options.env,
    workerName: (env) => env.osWorkerName,
    servingUrl: (env) => env.baseUrl,
    resources: (env) => env.resources,
    requiredSecrets: REQUIRED_SECRETS,
    optionalSecrets: OPTIONAL_SECRETS,
    buildEnv: (ctx) => posthogBuildEnv(ctx.secrets),
    prepare: async (ctx, secretValues, _credentials) => {
      // These are permanent fail-closed invariants, not a migration path.
      // Omitted Wrangler secrets survive code uploads, so check the current
      // Worker before any sidecar or OS version can be deployed.
      assertDopplerSecretAbsent({
        project: "os",
        config: ctx.env.dopplerConfig,
        secretName: RETIRED_AUTH_SERVICE_TOKEN,
        secrets: ctx.secrets,
      });
      // The live-secret assertions and JWKS fetch are independent network
      // reads. Complete them together before any deployed resource changes.
      const [staticAuthJwks, , currentWorkerBuildDeploymentId] = await runTimedDeployPhase(
        OS_DEPLOY_LABEL,
        "prepare: auth and secret preflight",
        () =>
          Promise.all([
            bakeStaticAuthJwks({
              authBaseUrl: ctx.env.authBaseUrl,
              envName: ctx.name,
              dopplerConfig: ctx.env.dopplerConfig,
              secrets: ctx.secrets,
            }),
            Promise.all(
              RETIRED_WORKER_SECRETS.map((secretName) =>
                assertWorkerSecretAbsent({
                  cf: ctx.cf,
                  workerName: ctx.env.osWorkerName,
                  secretName,
                }),
              ),
            ),
            readWorkerBuilderDeploymentId(ctx.env.baseUrl),
          ]),
      );

      reuseWorkerBuilder =
        desiredWorkerBuildDeploymentId !== UNVERSIONED_WORKER_BUILD_DEPLOYMENT_ID &&
        currentWorkerBuildDeploymentId === desiredWorkerBuildDeploymentId;
      console.log(
        reuseWorkerBuilder
          ? `worker builder already serves deployment ${desiredWorkerBuildDeploymentId}; skipping identical sidecar deploy`
          : `worker builder deployment is ${currentWorkerBuildDeploymentId ?? "unavailable"}; deploying ${desiredWorkerBuildDeploymentId}`,
      );

      // Baked at deploy time, so it's the one secret not in secrets.required.
      secretValues.APP_CONFIG_ITERATE_AUTH__JWKS = staticAuthJwks;

      // Preview deploys pass their PR head sha (scripts/preview/preview.ts)
      // so projects seeded there install that exact commit's pkg.pr.new build
      // of `iterate` instead of the template's @main — e2e tests then
      // exercise the branch tip's iterate/sdk, pinned (unlike @<pr>/@main,
      // which are moving refs). The pkg-pr-new GHA workflow publishes under
      // the PR HEAD sha on every push, so the URL exists by the time anything
      // npm-installs a seeded repo. Unset everywhere else (prod, local dev,
      // direct doppler-run deploys), leaving the template untouched.
      const previewHeadSha = process.env.PREVIEW_PULL_REQUEST_HEAD_SHA;
      if (previewHeadSha) {
        secretValues.APP_CONFIG_ITERATE_SDK_PACKAGE_SPEC = `https://pkg.pr.new/iterate/iterate/iterate@${previewHeadSha}`;
      }

      assertPreviewPetshopIntegrationConfigured(ctx.name, secretValues);

      // Parse the exact env the worker will see (secrets + generated vars) with
      // the worker's own schema — the strongest possible pre-flight.
      parseConfig({ ...secretValues, ...envShapedVars(ctx.env) });

      // writeWranglerConfig is a build input, so it stays in the serial
      // prepare phase. Vite calls the same write-if-changed generator again;
      // both see the identical environment-specific config.
      writeWranglerConfig();
    },
    prepareForUpload: async (ctx, secretValues, credentials) => {
      // Every item below is independent of the Vite build and of its peers,
      // but must finish before the main OS upload. Keep the Cloudflare
      // control-plane round trips, host-side template build, and typechecker
      // sidecar off one another's critical paths.
      await Promise.all([
        // Wrangler validates these bindings at upload, so every resource must
        // exist before deployApp uploads the main OS version.
        runTimedDeployPhase(OS_DEPLOY_LABEL, "prepare: queues", () =>
          ensureWorkerQueues(ctx, ctx.env.osWorkerName),
        ),
        runTimedDeployPhase(OS_DEPLOY_LABEL, "prepare: files bucket", () =>
          ensureR2Bucket(ctx.cf, `${ctx.env.osWorkerName}-files`),
        ),
        runTimedDeployPhase(OS_DEPLOY_LABEL, "prepare: search bucket", () =>
          ensureR2Bucket(ctx.cf, `${ctx.env.osWorkerName}-search-index`),
        ),
        // Exports cannot enable namespaces they create (upstream gap), so the
        // container classes must already be container-enabled.
        runTimedDeployPhase(OS_DEPLOY_LABEL, "prepare: container classes", () =>
          ensureContainerClasses({
            ctx,
            workerName: ctx.env.osWorkerName,
            containerClassNames: OS_CONTAINER_CLASS_NAMES,
            containerApplicationNames: OS_CONTAINER_CLASS_NAMES.map((className) =>
              containerApplicationName({ className, workerName: ctx.env.osWorkerName }),
            ),
            compatibilityDate: COMPATIBILITY_DATE,
          }),
        ),
        // Fresh projects use this trusted artifact instead of cold-starting a
        // builder container during projects.create. Runtime config and this
        // seed share the exact preview package spec set in prepare above.
        runTimedDeployPhase(OS_DEPLOY_LABEL, "prepare: template worker artifact", () =>
          seedTemplateWorkerArtifact({
            accountId: ctx.env.cloudflareAccountId,
            apiToken: credentials.CLOUDFLARE_API_TOKEN!,
            iterateSdkPackageSpec: secretValues.APP_CONFIG_ITERATE_SDK_PACKAGE_SPEC,
            kvNamespaceId: ctx.env.resources.workerBuildCacheKvId,
          }),
        ),
        // Host the builder namespace on its dedicated route-less sidecar. The
        // retired esbuild worker at this name is deliberately reused: legacy
        // bootstrap can add the class container-enabled without deleting any
        // Worker, then the declarative-exports deploy installs the real class.
        runTimedDeployPhase(OS_DEPLOY_LABEL, "prepare: wrangler.builder.jsonc", async () => {
          if (reuseWorkerBuilder) return;
          const builderWorkerName = workerBuilderWorkerName(ctx.env.osWorkerName);
          await ensureContainerClasses({
            ctx,
            workerName: builderWorkerName,
            containerClassNames: [WORKER_BUILDER_CONTAINER_CLASS_NAME],
            containerApplicationNames: [
              containerApplicationName({
                className: WORKER_BUILDER_CONTAINER_CLASS_NAME,
                workerName: builderWorkerName,
              }),
            ],
            compatibilityDate: COMPATIBILITY_DATE,
          });
          await runAsync(
            "pnpm",
            ["exec", "wrangler", "deploy", "--config", "wrangler.builder.jsonc", "--env", ctx.name],
            { cwd: OS_APP_ROOT, env: credentials },
          );
        }),
        // The typechecker remains a separately deployed worker service binding.
        runTimedDeployPhase(OS_DEPLOY_LABEL, "prepare: wrangler.typechecker.jsonc", () =>
          runAsync(
            "pnpm",
            [
              "exec",
              "wrangler",
              "deploy",
              "--config",
              "wrangler.typechecker.jsonc",
              "--env",
              ctx.name,
            ],
            { cwd: OS_APP_ROOT, env: credentials },
          ),
        ),
      ]);
    },
    smokes: osSmokes,
    afterDeploy: async (ctx) => {
      await Promise.all([
        smokeAuthRpc(ctx.env, "auth Workers RPC"),
        ...(ctx.name.startsWith("preview_")
          ? [
              waitForContainerRollouts({
                applicationNames: previewContainerApplicationNames(ctx.env),
                cf: ctx.cf,
              }),
            ]
          : []),
      ]);
    },
  });
}

void createCli({ ...import.meta, name: "deploy" }).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});
