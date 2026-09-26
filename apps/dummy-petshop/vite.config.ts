import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { dummyPetshopEnvs } from "../../envs.ts";
import { plainWorkerConfig } from "../../scripts/lib/wrangler-config.ts";

export default defineConfig({
  plugins: [
    cloudflare({
      config: {
        ...plainWorkerConfig(
          { name: "dummy-petshop", envs: dummyPetshopEnvs },
          process.env.CLOUDFLARE_ENV,
        ),
        // Declarative Durable Object lifecycle: Cloudflare reconciles this against the live
        // namespaces on every deploy, so there are no migration tags.
        exports: { PetshopStateDurableObject: { type: "durable-object", storage: "sqlite" } },
        durable_objects: {
          bindings: [{ name: "PETSHOP_STATE", class_name: "PetshopStateDurableObject" }],
        },
        // PETSHOP_SEAL_KEY is a worker secret, set once (`wrangler secret put`); deploys keep it.
        secrets: { required: ["PETSHOP_SEAL_KEY"] },
      },
    }),
  ],
});
