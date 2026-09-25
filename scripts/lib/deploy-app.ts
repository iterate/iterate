import { readFileSync, writeFileSync } from "node:fs";
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
 *   load the env's Doppler secrets → assert resources provisioned → collect secrets →
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
  /** The env's name (the deploy script's --env flag): the build's CLOUDFLARE_ENV. */
  name: string;
  /** Its envs.ts entry, which the deploy script looked up by that name. */
  env: E;
  dopplerProject: string;
  workerName: string;
  /** Public origin for the final success line. */
  servingUrl: string;
  /** Resource-ID map to assert provisioned (omit when the app owns none). */
  resources?: Record<string, string>;
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
  smokes: {
    url: string;
    /** Which HTTP statuses count as healthy for this probe. */
    ok: (status: number) => boolean;
    label: string;
  }[];
  /**
   * Deploy the Worker with no routes: its code, bindings, secrets and workers.dev host, and no
   * public hostname. For bringing a fresh Worker up BESIDE the one its hostnames still route to:
   * Cloudflare refuses a route pattern another Worker holds (10020, "A route with the same pattern
   * already exists", measured with wrangler 4.136.3 on 2026-09-24), and wrangler then exits 1
   * after the upload. With no routes in its config wrangler leaves the zone's routes alone, so the
   * operator moves each route to this Worker afterwards (`PUT /zones/<zone>/workers/routes/<id>`,
   * https://developers.cloudflare.com/api/resources/workers/subresources/routes/methods/update/),
   * and the next ordinary deploy finds them already its own. The smokes are skipped: the public
   * URLs still reach the other Worker.
   */
  withoutRoutes?: boolean;
}) {
  const ctx = await resolveEnvContext({
    name: input.name,
    env: input.env,
    dopplerProject: input.dopplerProject,
  });
  if (input.resources) assertProvisioned(ctx.name, input.resources);
  console.log(
    `Deploying ${input.appLabel} to ${ctx.name} (worker ${input.workerName}, account ${ctx.env.cloudflareAccountId})`,
  );

  const credentials = {
    CLOUDFLARE_API_TOKEN: ctx.secrets.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: ctx.env.cloudflareAccountId,
  };
  const secretValues = collectSecrets(ctx, input.requiredSecrets || []);
  await input.prepare?.(ctx, secretValues, credentials);
  await viteBuild(input.appRoot, ctx.name);
  const builtConfig = findBuiltWranglerConfig(input.appRoot);
  if (input.withoutRoutes) {
    const config = JSON.parse(readFileSync(builtConfig, "utf8"));
    writeFileSync(builtConfig, JSON.stringify({ ...config, routes: [] }));
    console.log(`Deploying ${input.workerName} without its ${config.routes?.length ?? 0} routes`);
  }

  await deployWithSecrets({ cwd: input.appRoot, builtConfig, secretValues, credentials });

  if (input.withoutRoutes)
    console.log(`smokes skipped: ${input.servingUrl} still routes to another Worker`);
  else
    for (const probe of input.smokes) {
      await smoke(probe.url, probe.ok, probe.label);
    }
  await input.afterDeploy?.(ctx, secretValues);

  console.log(`✅ ${ctx.name} deployed and serving at ${input.servingUrl}`);
}
