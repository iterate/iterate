import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  collectSecrets,
  deployWithSecrets,
  findBuiltWranglerConfig,
  run,
  smoke,
} from "./deploy-helpers.ts";
import {
  assertProvisioned,
  resolveEnvContext,
  type DeployableEnv,
  type EnvContext,
} from "./env-context.ts";
import { primaryWorkerDeployEndMarker, primaryWorkerDeployStartMarker } from "./deploy-output.ts";

/** One smoke probe against the deployed app. */
export interface SmokeProbe {
  url: string;
  /** Which HTTP statuses count as healthy for this probe. */
  ok: (status: number) => boolean;
  label: string;
}

/**
 * THE deploy pipeline — the same top-to-bottom program every app runs:
 *
 *   resolve --env → assert resources provisioned → collect secrets →
 *   app-specific prepare (migrations, seeds, config preflight) →
 *   build → deploy code+secrets in one version → app finalization → smoke-probe → ✅
 *
 * Durable Object classes are declared in each app's wrangler config
 * `exports` map and reconciled by the server on every primary deploy — no
 * migration tags or separate class bootstrap. A worker fresh, parked by
 * erase-data, or left in any state by another branch uses the same primary
 * upload. Cross-script dependants can finalize afterward through the explicit
 * hook below.
 *
 * This is a parameterized imperative function, not a framework: every input
 * is a plain value or a hook called exactly once at a fixed point you can
 * read below. Apps with genuinely unique steps (os's JWKS bake, auth's
 * admin seed) put them in `prepare`/`afterDeploy`; everything else is the
 * shared skeleton that used to be copy-pasted per app.
 */
export async function deployApp<E extends DeployableEnv>(input: {
  /** Absolute app root (wrangler/vite commands run here). */
  appRoot: string;
  /** e.g. "apps/os" — used in log lines. */
  appLabel: string;
  /** The app's env map from the root envs.ts. */
  envs: Record<string, E>;
  dopplerProject: string;
  /**
   * Target environment name from envs.ts (the deploy script's --env flag).
   * When absent, resolveEnvContext falls back to DOPPLER_CONFIG — CI's
   * `doppler run -- pnpm run-script deploy` carries no flags.
   */
  env?: string;
  workerName: (env: E) => string;
  /** Public origin for the final success line. */
  servingUrl: (env: E) => string;
  /** Resource-ID map to assert provisioned (omit when the app owns none). */
  resources?: (env: E) => Record<string, string>;
  /** Secret names the deploy fails without / ships when present. */
  requiredSecrets?: readonly string[];
  optionalSecrets?: readonly string[];
  /**
   * "vite": rm dist + `vite build` with CLOUDFLARE_ENV (the plugin snapshots
   * an env-flattened wrangler.json into dist). "checked-in-config": no build;
   * deploy the app's committed wrangler.jsonc with `--env <name>` (tunnels).
   */
  build?: "vite" | "checked-in-config";
  /** Extra env vars for the vite build (e.g. auth's inlined VITE_* values). */
  buildEnv?: (ctx: EnvContext<E>) => Record<string, string>;
  /**
   * Runs after secret collection, before build/deploy: config preflights,
   * D1 migrations, seed data. May add deploy-time-computed secrets to
   * `secretValues`. `credentials` carry CLOUDFLARE_API_TOKEN/ACCOUNT_ID for
   * wrangler subcommands.
   */
  prepare?: (
    ctx: EnvContext<E>,
    secretValues: Record<string, string>,
    credentials: Record<string, string>,
  ) => Promise<void> | void;
  /**
   * Runs after the primary Worker version is live but before any smoke probe.
   * This is reserved for resources that cannot be finalized until the new
   * Worker exists, such as a sidecar with cross-script Durable Object
   * bindings to classes introduced by that version.
   */
  afterCodeDeploy?: (
    ctx: EnvContext<E>,
    secretValues: Record<string, string>,
    credentials: Record<string, string>,
  ) => Promise<void> | void;
  /** Runs after a healthy deploy (e.g. auth's OAuth client seeding). */
  afterDeploy?: (ctx: EnvContext<E>, secretValues: Record<string, string>) => Promise<void> | void;
  smokes: (env: E) => SmokeProbe[];
}) {
  const ctx = await resolveEnvContext({
    envs: input.envs,
    dopplerProject: input.dopplerProject,
    env: input.env,
    allowDopplerConfigFallback: true,
  });
  if (input.resources) assertProvisioned(ctx.name, input.resources(ctx.env));
  const workerName = input.workerName(ctx.env);
  console.log(
    `Deploying ${input.appLabel} to ${ctx.name} (worker ${workerName}, account ${ctx.env.cloudflareAccountId})`,
  );

  const credentials = {
    CLOUDFLARE_API_TOKEN: ctx.secrets.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: ctx.env.cloudflareAccountId,
  };
  const secretValues = collectSecrets(ctx, input.requiredSecrets ?? [], input.optionalSecrets);

  await input.prepare?.(ctx, secretValues, credentials);

  let builtConfig: string;
  let extraDeployArgs: string[] | undefined;
  if (input.build === "checked-in-config") {
    builtConfig = "wrangler.jsonc";
    extraDeployArgs = ["--env", ctx.name];
  } else {
    rmSync(join(input.appRoot, "dist"), { recursive: true, force: true });
    run("pnpm", ["exec", "vite", "build"], {
      cwd: input.appRoot,
      env: { CLOUDFLARE_ENV: ctx.name, ...input.buildEnv?.(ctx) },
    });
    builtConfig = findBuiltWranglerConfig(input.appRoot);
  }

  console.log(primaryWorkerDeployStartMarker(workerName));
  await deployWithSecrets({
    cwd: input.appRoot,
    builtConfig,
    secretValues,
    credentials,
    extraDeployArgs,
  });
  console.log(primaryWorkerDeployEndMarker(workerName));

  await input.afterCodeDeploy?.(ctx, secretValues, credentials);

  for (const probe of input.smokes(ctx.env)) {
    await smoke(probe.url, probe.ok, probe.label);
  }
  await input.afterDeploy?.(ctx, secretValues);

  console.log(`✅ ${ctx.name} deployed and serving at ${input.servingUrl(ctx.env)}`);
}
