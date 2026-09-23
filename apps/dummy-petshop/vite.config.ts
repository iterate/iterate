import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { dummyPetshopEnvs } from "../../envs.ts";
import { OBSERVABILITY } from "../../scripts/lib/wrangler-config.ts";

// The Worker config comes from envs.ts: the top level is local dev, CLOUDFLARE_ENV (scripts/deploy.ts
// sets it) one deployed environment. `vite build` snapshots it into dist/, what deploy ships.
const env = process.env.CLOUDFLARE_ENV ? dummyPetshopEnvs[process.env.CLOUDFLARE_ENV] : undefined;
if (process.env.CLOUDFLARE_ENV && !env)
  throw new Error(`apps/dummy-petshop: unknown env ${JSON.stringify(process.env.CLOUDFLARE_ENV)}`);

export default defineConfig({
  plugins: [
    cloudflare({
      config: {
        name: env?.workerName ?? "dummy-petshop",
        main: "src/worker.ts",
        compatibility_date: "2026-06-17",
        // Declarative Durable Object lifecycle: Cloudflare reconciles this against the live
        // namespaces on every deploy, so there are no migration tags.
        exports: { PetshopStateDurableObject: { type: "durable-object", storage: "sqlite" } },
        durable_objects: {
          bindings: [{ name: "PETSHOP_STATE", class_name: "PetshopStateDurableObject" }],
        },
        // PETSHOP_SEAL_KEY is a worker secret, set once (`wrangler secret put`); deploys keep it.
        // PETSHOP_BACKDOOR_SECRET stays unset, so the os-next e2e rows can call /__backdoor/* directly.
        secrets: { required: ["PETSHOP_SEAL_KEY"] },
        observability: OBSERVABILITY,
        // its workers.dev origin only: no routes, no DNS, no custom domain
        ...(env && { account_id: env.cloudflareAccountId, workers_dev: true }),
      },
    }),
  ],
});
