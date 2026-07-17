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
 * The worker script is never deleted and routes are ensure-only, so a deploy
 * can never strand the env's hostnames (the old zombie-route/522 class).
 */
import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { envs, type DeployedEnv } from "../../../envs.ts";
import { bakeStaticAuthJwks } from "../../../scripts/lib/bake-auth-jwks.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";
import {
  assertDopplerSecretAbsent,
  assertWorkerSecretAbsent,
  run,
  smokeResponse,
} from "../../../scripts/lib/deploy-helpers.ts";
import { ensureContainerClasses } from "../../../scripts/lib/do-reset.ts";
import { parseConfig } from "../src/config.ts";
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
import { ensureWorkerEventsQueue } from "./event-queue-resources.ts";
import { ensureR2Bucket } from "./ensure-resources.ts";

const PREVIEW_PETSHOP_CONFIG = "APP_CONFIG_INTEGRATIONS__PETSHOP";

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

/** Deploy apps/os to a deployed environment (see scripts/lib/deploy-app.ts for the pipeline). */
export default async function deploy(
  options: {
    /** Target environment name from envs.ts (falls back to DOPPLER_CONFIG in CI). */
    env?: string;
  } = {},
) {
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
    prepare: async (ctx, secretValues, credentials) => {
      // These are permanent fail-closed invariants, not a migration path.
      // Omitted Wrangler secrets survive code uploads, so check the current
      // Worker before any sidecar or OS version can be deployed.
      assertDopplerSecretAbsent({
        project: "os",
        config: ctx.env.dopplerConfig,
        secretName: RETIRED_AUTH_SERVICE_TOKEN,
        secrets: ctx.secrets,
      });
      for (const secretName of RETIRED_WORKER_SECRETS) {
        await assertWorkerSecretAbsent({
          cf: ctx.cf,
          workerName: ctx.env.osWorkerName,
          secretName,
        });
      }

      // Baked at deploy time, so it's the one secret not in secrets.required.
      secretValues.APP_CONFIG_ITERATE_AUTH__JWKS = await bakeStaticAuthJwks({
        authBaseUrl: ctx.env.authBaseUrl,
        envName: ctx.name,
        dopplerConfig: ctx.env.dopplerConfig,
        secrets: ctx.secrets,
      });

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

      // Wrangler validates queue consumers during deploy, so the queue itself
      // has to exist before uploading a version that binds it. Artifact event
      // subscriptions are reconciled by ensure-resources because they are
      // account-level producer wiring, not a code deploy prerequisite.
      await ensureWorkerEventsQueue(ctx, ctx.env.osWorkerName);

      // Same rationale for R2: wrangler validates bucket bindings at upload,
      // and the files bucket is new — existing envs (previews, prd) get it
      // created here on their next deploy instead of a manual
      // ensure-resources run per environment.
      await ensureR2Bucket(ctx.cf, `${ctx.env.osWorkerName}-files`);
      // SEARCH_BUCKET (itx.search corpus, SPIKE) is likewise bound at upload
      // time, so existing envs need it created on their next deploy too.
      await ensureR2Bucket(ctx.cf, `${ctx.env.osWorkerName}-search-index`);

      // Sandbox container classes must exist container-enabled BEFORE the
      // exports deploy — the exports reconciliation can't enable namespaces
      // it creates (upstream gap; see ensureContainerClasses). Makes
      // brand-new environments deployable from scratch; no-op everywhere
      // else.
      await ensureContainerClasses({
        ctx,
        workerName: ctx.env.osWorkerName,
        containerClassNames: SANDBOX_INSTANCE_TYPES.map(
          (instanceType) => SANDBOX_INSTANCE_TYPE_BINDINGS[instanceType].className,
        ),
        compatibilityDate: COMPATIBILITY_DATE,
      });

      // The sidecars deploy FIRST: the os worker's BUILDER/TYPECHECKER
      // service bindings are by name, and a binding to a not-yet-existing
      // script fails the deploy. Sidecars have no secrets and no vite build —
      // wrangler bundles their entries directly (the toolchain wasm rides as
      // a wasm module). Builder skew window: between this deploy and the os
      // deploy (or if the os deploy fails), a bundler/schema-version bump
      // means the os worker hashes the OLD key prefix while the builder
      // writes the new one — the cache runs cold (correct output via
      // by-value returns, every request rebuilds) until the os deploy lands.
      // If "cache never hits" appears mid-rollout, finish the deploy.
      writeWranglerConfig();
      for (const sidecarConfig of ["wrangler.builder.jsonc", "wrangler.typechecker.jsonc"]) {
        run("pnpm", ["exec", "wrangler", "deploy", "--config", sidecarConfig, "--env", ctx.name], {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          env: credentials,
        });
      }
    },
    smokes: osSmokes,
    afterDeploy: async (ctx) => {
      await smokeAuthRpc(ctx.env, "auth Workers RPC");
    },
  });
}

void createCli({ ...import.meta, name: "deploy" }).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});
