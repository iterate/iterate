import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { z } from "zod";
import { ExampleAppEnv } from "./src/env.ts";

const EXAMPLE_D1_DATABASE_ID = "321cf9aa-2734-4709-95e5-71a817f6f899";

const env = ExampleAppEnv.extend({
  PORT: z.coerce.number().int().positive().default(17401),
  PREVIEW_PORT: z.coerce.number().int().positive().default(17411),
  CLOUDFLARE_WORKER_NAME: z.string().trim().min(1).default("dev-example"),
}).parse(process.env);

export default defineConfig(() => {
  return {
    server: {
      host: true,
      port: env.PORT,
      strictPort: false,
      watch: {
        ignored: ["**/routeTree.gen.ts"],
      },
    },
    preview: {
      host: true,
      port: env.PREVIEW_PORT,
      strictPort: true,
    },
    build: {
      target: "es2024",
    },
    plugins: [
      cloudflare({
        viteEnvironment: { name: "ssr" },
        config: {
          name: env.CLOUDFLARE_WORKER_NAME,
          compatibility_date: "2026-03-18",
          compatibility_flags: ["nodejs_compat"],
          d1_databases: [
            {
              binding: "DB",
              database_id: EXAMPLE_D1_DATABASE_ID,
              database_name: "dev-example-db",
              migrations_dir: "./drizzle",
              preview_database_id: EXAMPLE_D1_DATABASE_ID,
            },
          ],
          vars: {
            VITE_POSTHOG_PUBLIC_KEY: env.VITE_POSTHOG_PUBLIC_KEY,
            VITE_POSTHOG_PROXY_URL: env.VITE_POSTHOG_PROXY_URL,
            PIRATE_SECRET: env.PIRATE_SECRET,
          },
        },
      }),
      devtools({
        consolePiping: { enabled: false },
        editor: {
          name: "Cursor",
          open: async (path, lineNumber, columnNumber) => {
            const { exec } = await import("node:child_process");
            const location =
              `${path.replaceAll("$", "\\$")}` +
              `${lineNumber ? `:${lineNumber}` : ""}` +
              `${columnNumber ? `:${columnNumber}` : ""}`;
            exec(`cursor -g "${location}"`);
          },
        },
      }),
      tsconfigPaths({ projects: ["./tsconfig.json"] }),
      tanstackStart({
        srcDirectory: "src/frontend",
        spa: {
          enabled: true,
        },
      }),
      viteReact(),
      tailwindcss(),
    ],
  };
});
