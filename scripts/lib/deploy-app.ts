import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  collectSecrets,
  deployWithSecrets,
  findBuiltWranglerConfig,
  runAsync,
  smoke,
} from "./deploy-helpers.ts";
import {
  assertProvisioned,
  resolveEnvContext,
  type DeployableEnv,
  type EnvContext,
} from "./env-context.ts";

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
 *   app-specific prepare (migrations, seeds, config preflight) → build plus
 *   explicitly independent prerequisites → final pre-deploy mutations → deploy
 *   code+secrets in one version → smoke-probe → ✅
 *
 * Durable Object classes are declared in each app's wrangler config
 * `exports` map and reconciled by the server on every deploy — no migration
 * tags, no bootstrap ordering. A worker fresh, parked by erase-data, or left
 * in any state by another branch deploys the same way.
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
   * Independent prerequisites that may overlap the Vite build but MUST
   * complete before code upload. Both lanes are joined (including on failure)
   * before deploy, so this cannot expose a version whose prerequisites are
   * still running.
   */
  concurrentBuildWork?: (
    ctx: EnvContext<E>,
    secretValues: Record<string, string>,
    credentials: Record<string, string>,
  ) => Promise<void> | void;
  /**
   * Runs only after a successful build, immediately before code upload. Use
   * for destructive rollout steps that must not run when the build is broken.
   */
  beforeDeploy?: (
    ctx: EnvContext<E>,
    secretValues: Record<string, string>,
    credentials: Record<string, string>,
  ) => Promise<void> | void;
  /** Runs after a healthy deploy (e.g. auth's OAuth client seeding). */
  afterDeploy?: (ctx: EnvContext<E>, secretValues: Record<string, string>) => Promise<void> | void;
  /**
   * Extra `wrangler deploy` args after prepare (e.g. OS's
   * `--containers-rollout none` on warm redeploys). Called after `prepare` so
   * it can depend on bootstrap results. Merged with any build-mode args.
   */
  extraDeployArgs?: (
    ctx: EnvContext<E>,
    secretValues: Record<string, string>,
  ) => string[] | undefined;
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
  // Resolve build-only inputs before app-specific preparation mutates any
  // deployed resource. A missing upload/build credential must fail the whole
  // deploy before sidecars, queues, buckets, or migrations advance.
  const buildEnv = input.buildEnv?.(ctx);

  await input.prepare?.(ctx, secretValues, credentials);

  const concurrentBuildWork = Promise.resolve().then(() =>
    input.concurrentBuildWork?.(ctx, secretValues, credentials),
  );
  let builtConfig: string;
  const extraDeployArgs: string[] = [];
  if (input.build === "checked-in-config") {
    builtConfig = "wrangler.jsonc";
    extraDeployArgs.push("--env", ctx.name);
    await concurrentBuildWork;
  } else {
    rmSync(join(input.appRoot, "dist"), { recursive: true, force: true });
    const results = await Promise.allSettled([
      runAsync("pnpm", ["exec", "vite", "build"], {
        cwd: input.appRoot,
        env: { CLOUDFLARE_ENV: ctx.name, ...buildEnv },
      }),
      concurrentBuildWork,
    ]);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "App build and concurrent build work both failed");
    }
    builtConfig = findBuiltWranglerConfig(input.appRoot);
  }
  await input.beforeDeploy?.(ctx, secretValues, credentials);
  extraDeployArgs.push(...(input.extraDeployArgs?.(ctx, secretValues) ?? []));

  await deployWithSecrets({
    cwd: input.appRoot,
    builtConfig,
    secretValues,
    credentials,
    extraDeployArgs: extraDeployArgs.length ? extraDeployArgs : undefined,
  });

  for (const probe of input.smokes(ctx.env)) {
    await smoke(probe.url, probe.ok, probe.label);
  }
  await input.afterDeploy?.(ctx, secretValues);

  console.log(`✅ ${ctx.name} deployed and serving at ${input.servingUrl(ctx.env)}`);
}
