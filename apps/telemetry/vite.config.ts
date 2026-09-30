import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { getEnv, telemetryEnvs } from "../../envs.ts";
import { OBSERVABILITY, plainWorkerConfig } from "../../scripts/lib/wrangler-config.ts";

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
        // Its own logs and spans go to no destination: they would be posted back to it.
        observability: {
          ...OBSERVABILITY,
          logs: { ...OBSERVABILITY.logs, destinations: [] },
          traces: { ...OBSERVABILITY.traces, destinations: [] },
        },
        pipelines: [
          { binding: "LOGS", stream: streams.logs.id },
          { binding: "SPANS", stream: streams.spans.id },
        ],
        // scripts/ensure-resources.ts rotates it in Doppler; scripts/deploy.ts ships it from there.
        secrets: { required: ["TELEMETRY_OTLP_SECRET"] },
      },
    }),
  ],
});
