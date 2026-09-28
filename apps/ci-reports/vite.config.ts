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
      },
    }),
  ],
});
