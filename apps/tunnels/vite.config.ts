import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { tunnelsEnvs } from "../../envs.ts";
import { OBSERVABILITY, registrableDomainOf } from "../../scripts/lib/wrangler-config.ts";

// As in the other Vite apps, envs.ts selects one Worker, without legacy Wrangler env blocks.
// A future deploy removes the old cf:service=tunnels-dev / cf:environment=prd grouping tags.
// The Worker name and DO class below preserve the existing namespace identity.
const env = process.env.CLOUDFLARE_ENV ? tunnelsEnvs[process.env.CLOUDFLARE_ENV] : undefined;
if (process.env.CLOUDFLARE_ENV && !env)
  throw new Error(
    `apps/tunnels: unknown env ${JSON.stringify(process.env.CLOUDFLARE_ENV)}; known envs: ${Object.keys(tunnelsEnvs).join(", ")}`,
  );

export default defineConfig({
  plugins: [
    cloudflare({
      config: {
        name: env?.workerName ?? "tunnels",
        main: "src/worker.ts",
        // Preserve the live gateway's compatibility behaviour when restoring its deploy path.
        compatibility_date: "2026-06-17",
        compatibility_flags: ["nodejs_compat"],
        exports: { CaptunServerShard: { type: "durable-object", storage: "sqlite" } },
        durable_objects: {
          bindings: [{ name: "CaptunServerShard", class_name: "CaptunServerShard" }],
        },
        vars: {
          CUSTOM_HOSTNAME: env?.hostname ?? "localhost",
          SHARD_COUNT: "1",
        },
        secrets: { required: ["CAPTUN_TOKEN"] },
        observability: OBSERVABILITY,
        ...(env && {
          account_id: env.cloudflareAccountId,
          workers_dev: true,
          routes: [
            { pattern: `${env.hostname}/*`, zone_name: registrableDomainOf(env.hostname) },
            { pattern: `*.${env.hostname}/*`, zone_name: registrableDomainOf(env.hostname) },
          ],
        }),
      },
    }),
  ],
});
