/**
 * Deploy apps/os to a deployed environment:
 *
 *   pnpm run deploy --env preview_3
 *   pnpm run deploy --env prd
 *
 * Runs the shared pipeline (scripts/lib/deploy-app.ts). Steps, all fail-fast:
 *   1. Before touching a deployed resource, assert that every retired Worker
 *      secret is absent and that the removed auth service token is absent
 *      from Doppler. Then verify required secrets, bake the static auth JWKS,
 *      validate the exact runtime config, and ensure resource prerequisites.
 *   2. Deploy the builder and typechecker prerequisites. Deploy the full
 *      script executor when its OS-owned authority classes already exist;
 *      otherwise preserve or create its authority-free service identity.
 *   3. `vite build` with CLOUDFLARE_ENV=<env>; the build output's
 *      wrangler.json is flattened for that env from freshly generated config,
 *      including its declarative Durable Object exports.
 *   4. `wrangler deploy --config <built config> --secrets-file <doppler>` —
 *      secrets land atomically with the product code and its declarative
 *      Durable Object exports.
 *   5. Finalize the full script executor now that those exports exist, then
 *      smoke-probe the deployed base URL and force an uncached project-
 *      directory lookup through AUTH; exit nonzero unless both are healthy.
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
import { ensureContainerClasses, getWorkerDoNamespaces } from "../../../scripts/lib/do-reset.ts";
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
  scriptExecutorWorkerName,
  writeWranglerConfig,
} from "./generate-wrangler-config.ts";
import { ensureWorkerEventsQueue } from "./event-queue-resources.ts";
import { ensureR2Bucket } from "./ensure-resources.ts";

const RETIRED_AUTH_SERVICE_TOKEN = "APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN";
const RETIRED_WORKER_SECRETS = [
  RETIRED_AUTH_SERVICE_TOKEN,
  "APP_CONFIG_GEMINI_API_KEY",
  "APP_CONFIG_LOGS",
  "APP_CONFIG_X_AI_API_KEY",
] as const;
const PREVIEW_PETSHOP_CONFIG = "APP_CONFIG_INTEGRATIONS__PETSHOP";
const SCRIPT_EXECUTOR_AUTHORITY_CLASSES = [
  "CapabilityHostDurableObject",
  "ProjectDurableObject",
] as const;

export function scriptExecutorDeploymentPlan(input: {
  authorityClassNames: Iterable<string>;
  executorExists: boolean;
}): {
  afterPrimary: "full" | "none";
  beforePrimary: "bootstrap" | "full" | "none";
  missingAuthorityClasses: string[];
} {
  const authorityClassNames = new Set(input.authorityClassNames);
  const missingAuthorityClasses = SCRIPT_EXECUTOR_AUTHORITY_CLASSES.filter(
    (className) => !authorityClassNames.has(className),
  );
  if (missingAuthorityClasses.length === 0) {
    return { afterPrimary: "none", beforePrimary: "full", missingAuthorityClasses };
  }
  return {
    afterPrimary: "full",
    beforePrimary: input.executorExists ? "none" : "bootstrap",
    missingAuthorityClasses,
  };
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
  const appRoot = fileURLToPath(new URL("..", import.meta.url));
  let finalizeScriptExecutorAfterPrimary = false;
  await deployApp({
    appRoot,
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

      // Builder and typechecker deploy first because the OS service bindings
      // require named scripts. The executor has a genuine dependency cycle:
      // OS binds its service, while the executor binds OS-owned DO classes.
      // If those classes are already live, deploy the full executor now. A
      // fresh/parked OS has no such exports; retain an existing executor or
      // create the authority-free bootstrap identity, restore OS, then deploy
      // the full executor in afterCodeDeploy before any smoke probe.
      writeWranglerConfig();
      for (const sidecarConfig of ["wrangler.builder.jsonc", "wrangler.typechecker.jsonc"]) {
        run("pnpm", ["exec", "wrangler", "deploy", "--config", sidecarConfig, "--env", ctx.name], {
          cwd: appRoot,
          env: credentials,
        });
      }

      const [authorityNamespaces, scripts] = await Promise.all([
        getWorkerDoNamespaces(ctx, ctx.env.osWorkerName),
        ctx.cf<{ id: string }[]>("/workers/scripts"),
      ]);
      const executorWorkerName = scriptExecutorWorkerName(ctx.env.osWorkerName);
      const executorPlan = scriptExecutorDeploymentPlan({
        authorityClassNames: authorityNamespaces.map((namespace) => namespace.className),
        executorExists: scripts.some((script) => script.id === executorWorkerName),
      });
      console.log(
        `script executor deployment: before primary=${executorPlan.beforePrimary}, ` +
          `after primary=${executorPlan.afterPrimary}` +
          (executorPlan.missingAuthorityClasses.length === 0
            ? ""
            : ` (primary worker is missing ${executorPlan.missingAuthorityClasses.join(", ")})`),
      );
      if (executorPlan.beforePrimary !== "none") {
        const config =
          executorPlan.beforePrimary === "full"
            ? "wrangler.script-executor.jsonc"
            : "wrangler.script-executor-bootstrap.jsonc";
        run("pnpm", ["exec", "wrangler", "deploy", "--config", config, "--env", ctx.name], {
          cwd: appRoot,
          env: credentials,
        });
      }
      finalizeScriptExecutorAfterPrimary = executorPlan.afterPrimary === "full";
    },
    afterCodeDeploy: (ctx, _secretValues, credentials) => {
      if (!finalizeScriptExecutorAfterPrimary) return;
      run(
        "pnpm",
        [
          "exec",
          "wrangler",
          "deploy",
          "--config",
          "wrangler.script-executor.jsonc",
          "--env",
          ctx.name,
        ],
        { cwd: appRoot, env: credentials },
      );
      finalizeScriptExecutorAfterPrimary = false;
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
