import { COMPATIBILITY_DATE } from "iterate/compatibility-date";
import { OBSERVABILITY } from "../../core/os/scripts/wrangler-config.ts";

/** A plain Worker's config (dummy-petshop, ci-reports) for one envs.ts environment — or, with none,
 *  local dev: what every plain Worker shares. Its vite.config.ts adds its own bindings and secrets
 *  and hands the whole to the Cloudflare Vite plugin; `vite build` snapshots it into dist/, what
 *  deploy ships. The environment is CLOUDFLARE_ENV, as the app's scripts/deploy.ts sets it. A
 *  deployed plain Worker serves on its workers.dev origin only: no routes, no DNS, no custom domain.
 *  The start apps' counterpart is start-app.ts `startAppWorkerConfig`. */
export function plainWorkerConfig(
  worker: {
    name: string;
    envs: Record<string, { workerName: string; cloudflareAccountId: string }>;
  },
  envName: string | undefined,
) {
  const env = envName ? worker.envs[envName] : undefined;
  if (envName && !env)
    throw new Error(
      `apps/${worker.name}: unknown env ${JSON.stringify(envName)}; known envs: ${Object.keys(worker.envs).join(", ")}`,
    );
  return {
    name: env?.workerName || worker.name,
    main: "src/worker.ts",
    compatibility_date: COMPATIBILITY_DATE,
    observability: OBSERVABILITY,
    ...(env && { account_id: env.cloudflareAccountId, workers_dev: true }),
  };
}
