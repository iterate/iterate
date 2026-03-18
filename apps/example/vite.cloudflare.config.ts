import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { z } from "zod";
import { ExampleAppEnv } from "./src/env.ts";

const env = ExampleAppEnv.extend({
  CLOUDFLARE_WORKER_NAME: z.string().trim().min(1).default("dev-example"),
  CLOUDFLARE_D1_DATABASE_ID: z.string().trim().min(1),
}).parse(process.env);

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      config: {
        name: env.CLOUDFLARE_WORKER_NAME,
        main: "./src/server.ts",
        compatibility_date: "2026-03-18",
        compatibility_flags: ["nodejs_compat"],
        assets: {
          not_found_handling: "single-page-application",
          run_worker_first: ["/api/*"],
        },
        d1_databases: [
          {
            binding: "DB",
            // This app binds to an already-created D1 database, so the deploy-time
            // requirement is the database ID. Keeping only the ID in env avoids
            // duplicating a human-readable name that Cloudflare does not need to
            // attach the binding during build/deploy.
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
      spa: {
        enabled: true,
        prerender: {
          outputPath: "/index.html",
        },
      },
    }),
    viteReact(),
    tailwindcss(),
  ],
});
