import { readFileSync, writeFileSync } from "node:fs";
import {
  collectSecrets,
  deployWithSecrets,
  findBuiltWranglerConfig,
  smoke,
} from "./deploy-helpers.ts";
import { resolveEnvContext, type DeployableEnv, type EnvContext } from "./env-context.ts";
import { viteBuild } from "./vite-build.ts";

/**
 * THE deploy pipeline — the same top-to-bottom program every app runs:
 *
 *   resolve --env → collect secrets → app-specific prepare (config
 *   preflight, synced assets) → build (vite's, or the app's own) → deploy
 *   code+secrets in one version → smoke-probe → ✅
 *
 * Durable Object classes are declared in each app's wrangler config
 * `exports` map and reconciled by the server on every deploy — no migration
 * tags, no bootstrap ordering. A worker fresh, parked by erase-data, or left
 * in any state by another branch deploys the same way.
 *
 * This is a parameterized imperative function, not a framework: every input
 * is a plain value or a hook called exactly once at a fixed point you can
 * read below. Apps with genuinely unique steps put them in `prepare`.
 */
export async function deployApp<
  E extends DeployableEnv & {
    workerName: string;
    /** Public origin: where a smoke path starting with "/" is probed, and the success line. */
    baseUrl: string;
  },
>(
  /** The deploy script's `--env`, looked up (envs.ts `getEnv`, `getOsEnv`). */
  env: E,
  options: {
    dopplerProject: string;
    /** Absolute app root (wrangler/vite commands run here). */
    appRoot: string;
    /** e.g. "apps/os" — used in log lines. */
    appLabel: string;
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
    /** Writes dist/, whose one `wrangler.json` is what deploys: `vite build` for the env
     *  (vite-build.ts `viteBuild`) unless the app builds itself, as the SPA's static files do. */
    build?: (ctx: EnvContext<E>) => Promise<void>;
    /** Probed after the deploy, each until it answers healthy. */
    smokes: {
      /** Absolute, or a path starting with "/" under `env.baseUrl`. */
      url: string;
      /** Whether the answer is the healthy one: its status, or its body where a fallback could
       *  answer the same status. */
      ok: (response: Response) => boolean | Promise<boolean>;
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
  },
) {
  const ctx = await resolveEnvContext(env, { dopplerProject: options.dopplerProject });
  console.log(
    `Deploying ${options.appLabel} to ${env.name} (worker ${env.workerName}, account ${env.cloudflareAccountId})`,
  );

  const credentials = {
    CLOUDFLARE_API_TOKEN: ctx.secrets.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: env.cloudflareAccountId,
  };
  const secretValues = collectSecrets(ctx, options.requiredSecrets || []);
  await options.prepare?.(ctx, secretValues, credentials);
  await (options.build
    ? options.build(ctx)
    : viteBuild(options.appRoot, { CLOUDFLARE_ENV: env.name }));
  const builtConfig = findBuiltWranglerConfig(options.appRoot);
  if (options.withoutRoutes) {
    const config = JSON.parse(readFileSync(builtConfig, "utf8"));
    writeFileSync(builtConfig, JSON.stringify({ ...config, routes: [] }));
    console.log(`Deploying ${env.workerName} without its ${config.routes?.length ?? 0} routes`);
  }

  await deployWithSecrets({ cwd: options.appRoot, builtConfig, secretValues, credentials });

  if (options.withoutRoutes)
    console.log(`smokes skipped: ${env.baseUrl} still routes to another Worker`);
  else
    for (const probe of options.smokes) {
      const url = probe.url.startsWith("/") ? `${env.baseUrl}${probe.url}` : probe.url;
      await smoke(url, probe.ok, probe.label);
    }

  console.log(`✅ ${env.name} deployed and serving at ${env.baseUrl}`);
}
