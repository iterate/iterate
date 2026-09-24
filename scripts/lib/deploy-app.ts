import {
  collectSecrets,
  deployWithSecrets,
  findBuiltWranglerConfig,
  smoke,
  viteBuild,
} from "./deploy-helpers.ts";
import {
  assertProvisioned,
  resolveEnvContext,
  type DeployableEnv,
  type EnvContext,
} from "./env-context.ts";

/**
 * THE deploy pipeline — the same top-to-bottom program every app runs:
 *
 *   resolve --env → assert resources provisioned → collect secrets →
 *   app-specific prepare (config preflight, synced assets) → vite build → deploy
 *   code+secrets in one version → smoke-probe → afterDeploy → ✅
 *
 * Durable Object classes are declared in each app's wrangler config
 * `exports` map and reconciled by the server on every deploy — no migration
 * tags, no bootstrap ordering. A worker fresh, parked by erase-data, or left
 * in any state by another branch deploys the same way.
 *
 * This is a parameterized imperative function, not a framework: every input
 * is a plain value or a hook called exactly once at a fixed point you can
 * read below. Apps with genuinely unique steps put them in
 * `prepare`/`afterDeploy`.
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
  /** Secret names the deploy fails without; each ships with the code. */
  requiredSecrets?: readonly string[];
  /**
   * Runs after secret collection, before build/deploy: config preflights,
   * synced assets. May add deploy-time-computed secrets to `secretValues`.
   * `credentials` carry CLOUDFLARE_API_TOKEN/ACCOUNT_ID for wrangler
   * subcommands.
   */
  prepare?: (
    ctx: EnvContext<E>,
    secretValues: Record<string, string>,
    credentials: Record<string, string>,
  ) => Promise<void> | void;
  /** Runs after a healthy deploy. */
  afterDeploy?: (ctx: EnvContext<E>, secretValues: Record<string, string>) => Promise<void> | void;
  smokes: (env: E) => {
    url: string;
    /** Which HTTP statuses count as healthy for this probe. */
    ok: (status: number) => boolean;
    label: string;
  }[];
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
  const secretValues = collectSecrets(ctx, input.requiredSecrets || []);
  await input.prepare?.(ctx, secretValues, credentials);
  await viteBuild(input.appRoot, ctx.name);

  await deployWithSecrets({
    cwd: input.appRoot,
    builtConfig: findBuiltWranglerConfig(input.appRoot),
    secretValues,
    credentials,
  });

  for (const probe of input.smokes(ctx.env)) {
    await smoke(probe.url, probe.ok, probe.label);
  }
  await input.afterDeploy?.(ctx, secretValues);

  console.log(`✅ ${ctx.name} deployed and serving at ${input.servingUrl(ctx.env)}`);
}
