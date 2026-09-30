import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { getEnv, telemetryEnvs } from "../../envs.ts";
import { plainWorkerConfig } from "../../scripts/lib/wrangler-config.ts";

// Built for one envs.ts environment only (scripts/deploy.ts sets it): its bindings are that
// environment's streams.
const { streams } = getEnv(process.env.CLOUDFLARE_ENV || "", telemetryEnvs);

export default defineConfig({
  plugins: [
    cloudflare({
      config: {
        ...plainWorkerConfig(
          { name: "telemetry", envs: telemetryEnvs },
          process.env.CLOUDFLARE_ENV,
        ),
        pipelines: [
          { binding: "LOGS", stream: streams.logs },
          { binding: "SPANS", stream: streams.spans },
        ],
        // scripts/ensure-resources.ts makes it in Doppler; scripts/deploy.ts ships it from there.
        secrets: { required: ["TELEMETRY_OTLP_SECRET"] },
      },
    }),
  ],
});
