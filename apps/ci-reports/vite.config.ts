import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { ciReportsEnvs } from "../../envs.ts";
import { COMPATIBILITY_DATE, OBSERVABILITY } from "../../scripts/lib/wrangler-config.ts";

// The Worker config comes from envs.ts: the top level is local dev, CLOUDFLARE_ENV (scripts/deploy.ts
// sets it) one deployed environment. `vite build` snapshots it into dist/, what deploy ships.
const env = process.env.CLOUDFLARE_ENV ? ciReportsEnvs[process.env.CLOUDFLARE_ENV] : undefined;
if (process.env.CLOUDFLARE_ENV && !env)
  throw new Error(
    `apps/ci-reports: unknown env ${JSON.stringify(process.env.CLOUDFLARE_ENV)}; known envs: ${Object.keys(ciReportsEnvs).join(", ")}`,
  );

export default defineConfig({
  plugins: [
    cloudflare({
      config: {
        name: env?.workerName ?? "ci-reports",
        main: "src/worker.ts",
        compatibility_date: COMPATIBILITY_DATE,
        // Depot's organization token, the one CI telemetry reads Depot with; scripts/deploy.ts ships
        // it from Doppler _shared/preview with every version.
        secrets: { required: ["DEPOT_CI_TELEMETRY_TOKEN"] },
        observability: OBSERVABILITY,
        // its workers.dev origin only: no routes, no DNS, no custom domain
        ...(env && { account_id: env.cloudflareAccountId, workers_dev: true }),
      },
    }),
  ],
});
