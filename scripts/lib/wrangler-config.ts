/** The workerd compatibility date every Iterate Worker deploys with. apps/os's wrangler*.jsonc
 *  repeat it (JSON cannot import) and wrangler-config.test.ts pins them to it. */
export const COMPATIBILITY_DATE = "2026-09-01";

/**
 * The one observability posture every Iterate worker deploys with: full
 * sampling, persistent logs and traces. Shared by every app's Worker config.
 */
export const OBSERVABILITY = {
  enabled: true,
  head_sampling_rate: 1,
  logs: { enabled: true, head_sampling_rate: 1, persist: true, invocation_logs: true },
  traces: { enabled: true, persist: true, head_sampling_rate: 1 },
};

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
    name: env?.workerName ?? worker.name,
    main: "src/worker.ts",
    compatibility_date: COMPATIBILITY_DATE,
    observability: OBSERVABILITY,
    ...(env && { account_id: env.cloudflareAccountId, workers_dev: true }),
  };
}

/** The registrable domain of a URL or hostname — its last two labels (`os.iterate.com` ⇒ `iterate.com`;
 *  a workers.dev origin ⇒ `<subdomain>.workers.dev`, the account's own). The zone a hostname routes
 *  on: the start apps' routes and the OS platform's wrangler config and ensure-resources. */
export function registrableDomainOf(urlOrHostname: string) {
  const hostname = urlOrHostname.includes("://") ? new URL(urlOrHostname).hostname : urlOrHostname;
  const labels = hostname.split(".");
  return labels.slice(hostname.endsWith(".workers.dev") ? -3 : -2).join(".");
}
