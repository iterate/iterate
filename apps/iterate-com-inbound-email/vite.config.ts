import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { iterateComInboundEmailEnvs } from "../../envs.ts";
import { plainWorkerConfig } from "../../scripts/lib/wrangler-config.ts";

export default defineConfig({
  plugins: [
    cloudflare({
      config: plainWorkerConfig(
        { name: "iterate-com-inbound-email", envs: iterateComInboundEmailEnvs },
        process.env.CLOUDFLARE_ENV,
      ),
    }),
  ],
});
