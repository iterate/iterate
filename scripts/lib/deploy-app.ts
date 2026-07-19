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
 * Emit one stable timing pair around a deploy phase. Preview CI is dominated
 * by remote control-plane waits, so a single app-level duration is not enough
 * to distinguish our build from Cloudflare upload, resource reconciliation,
 * or readiness. Keep this helper tiny and shared so app-specific preparation
 * can use the same log contract as the generic deploy pipeline.
 */
export async function runTimedDeployPhase<T>(
  appLabel: string,
  phase: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  console.log(`[deploy:${appLabel}] phase start: ${phase}`);
  let outcome = "passed";
  try {
    return await operation();
  } catch (error) {
    outcome = "failed";
    throw error;
  } finally {
    const elapsedSeconds = (performance.now() - startedAt) / 1_000;
    console.log(
      `[deploy:${appLabel}] phase finish: ${phase} (${elapsedSeconds.toFixed(1)}s, ${outcome})`,
    );
  }
}

/**
 * THE deploy pipeline — the same top-to-bottom program every app runs:
 *
 *   resolve --env → assert resources provisioned → collect secrets →
 *   app-specific prepare (migrations, seeds, config preflight) →
 *   build + independent upload prerequisites →
 *   deploy code+secrets in one version → smoke-probe → ✅
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
  /** App-specific Wrangler deploy flags resolved after `prepare` (for example,
   * skipping an unchanged container rollout). */
  deployArgs?: (ctx: EnvContext<E>) => readonly string[];
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
   * Remote prerequisites that do not affect the build, but must finish before
   * the main upload (resource ensures, independently deployed sidecars).
   * Runs concurrently with a Vite build to keep control-plane latency off the
   * critical path. Anything that writes build inputs belongs in `prepare`.
   */
  prepareForUpload?: (
    ctx: EnvContext<E>,
    secretValues: Record<string, string>,
    credentials: Record<string, string>,
  ) => Promise<void> | void;
  /** Runs after a healthy deploy (e.g. auth's OAuth client seeding). */
  afterDeploy?: (ctx: EnvContext<E>, secretValues: Record<string, string>) => Promise<void> | void;
  smokes: (env: E) => SmokeProbe[];
}) {
  const ctx = await runTimedDeployPhase(input.appLabel, "resolve environment", () =>
    resolveEnvContext({
      envs: input.envs,
      dopplerProject: input.dopplerProject,
      env: input.env,
      allowDopplerConfigFallback: true,
    }),
  );
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

  const prepare = input.prepare;
  if (prepare) {
    await runTimedDeployPhase(input.appLabel, "prepare", () =>
      prepare(ctx, secretValues, credentials),
    );
  }

  const prepareForUpload = input.prepareForUpload;
  const uploadPreparation = prepareForUpload
    ? runTimedDeployPhase(input.appLabel, "prepare for upload", () =>
        prepareForUpload(ctx, secretValues, credentials),
      )
    : Promise.resolve();

  let builtConfig: string;
  let extraDeployArgs = [...(input.deployArgs?.(ctx) ?? [])];
  if (input.build === "checked-in-config") {
    await uploadPreparation;
    builtConfig = "wrangler.jsonc";
    extraDeployArgs = ["--env", ctx.name, ...extraDeployArgs];
  } else {
    await Promise.all([
      runTimedDeployPhase(input.appLabel, "build", () => {
        rmSync(join(input.appRoot, "dist"), { recursive: true, force: true });
        return runAsync("pnpm", ["exec", "vite", "build"], {
          cwd: input.appRoot,
          env: { CLOUDFLARE_ENV: ctx.name, ...buildEnv },
        });
      }),
      uploadPreparation,
    ]);
    builtConfig = findBuiltWranglerConfig(input.appRoot);
  }

  await runTimedDeployPhase(input.appLabel, "upload and reconcile", () =>
    deployWithSecrets({
      cwd: input.appRoot,
      builtConfig,
      secretValues,
      credentials,
      extraDeployArgs,
    }),
  );

  await Promise.all(
    input
      .smokes(ctx.env)
      .map((probe) =>
        runTimedDeployPhase(input.appLabel, `smoke: ${probe.label}`, () =>
          smoke(probe.url, probe.ok, probe.label),
        ),
      ),
  );
  const afterDeploy = input.afterDeploy;
  if (afterDeploy) {
    await runTimedDeployPhase(input.appLabel, "after deploy", () => afterDeploy(ctx, secretValues));
  }

  console.log(`✅ ${ctx.name} deployed and serving at ${input.servingUrl(ctx.env)}`);
}
