import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { z } from "zod";
import { ExampleAppEnv } from "./src/env.ts";

const LOCAL_D1_DATABASE_ID = "local-example-db";

export default defineConfig(() => {
  const env = ExampleAppEnv.extend({
    CLOUDFLARE_WORKER_NAME: z.string().trim().min(1).default("dev-example"),
    // Cloudflare's D1 binding config still wants an ID even for local dev.
    // Default to a local placeholder so `pnpm cf:dev` works without deploy-time
    // wiring. Real deploys should provide `CLOUDFLARE_D1_DATABASE_ID`.
    CLOUDFLARE_D1_DATABASE_ID: z.string().trim().min(1).default(LOCAL_D1_DATABASE_ID),
  }).parse(process.env);

  return {
    resolve: {
      tsconfigPaths: true,
    },
    plugins: [
      cloudflare({
        viteEnvironment: { name: "ssr" },
        config: {
          name: env.CLOUDFLARE_WORKER_NAME,
          main: "./src/worker.ts",
          compatibility_date: "2026-02-05",
          compatibility_flags: ["nodejs_compat"],
          d1_databases: [
            {
              binding: "DB",
              database_id: env.CLOUDFLARE_D1_DATABASE_ID,
              migrations_dir: "./drizzle",
              preview_database_id: env.CLOUDFLARE_D1_DATABASE_ID,
            },
          ],
          vars: {
            VITE_POSTHOG_PUBLIC_KEY: env.VITE_POSTHOG_PUBLIC_KEY,
            VITE_POSTHOG_PROXY_URL: env.VITE_POSTHOG_PROXY_URL,
            PIRATE_SECRET: env.PIRATE_SECRET,
          },
        },
      }),
      tanstackStart({
        srcDirectory: "src/frontend",
      }),
      viteReact(),
      tailwindcss(),
    ],
  };
});
