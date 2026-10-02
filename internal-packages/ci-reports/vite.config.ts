import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { ciReportsEnvs } from "../../envs.ts";
import { plainWorkerConfig } from "../../scripts/lib/wrangler-config.ts";

export default defineConfig({
  plugins: [
    cloudflare({
      config: {
        ...plainWorkerConfig(
          { name: "ci-reports", envs: ciReportsEnvs },
          process.env.CLOUDFLARE_ENV,
        ),
        // Depot's organization token, the one CI telemetry reads Depot with; scripts/deploy.ts ships
        // it from Doppler _shared/preview with every version.
        secrets: { required: ["DEPOT_CI_TELEMETRY_TOKEN"] },
        // `vite dev` as a person Cloudflare Access signed in (src/worker.ts refuses anyone else);
        // deployed, Access itself does the signing in
        access: { dev: { aud: "ci-reports-dev", identity: { email: "dev@localhost" } } },
      },
    }),
  ],
});
