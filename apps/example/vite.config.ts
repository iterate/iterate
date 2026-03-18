import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { z } from "zod";
import { ExampleAppEnv } from "./src/env.ts";

const env = ExampleAppEnv.extend({
  PORT: z.coerce.number().int().positive().default(17401),
  API_BASE_URL: z.string().default("http://127.0.0.1:17402"),
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
      proxy: {
        "/api": {
          target: env.API_BASE_URL,
          changeOrigin: true,
          ws: true,
        },
      },
    },
    preview: {
      host: true,
      port: env.PORT,
      strictPort: true,
      proxy: {
        "/api": {
          target: env.API_BASE_URL,
          changeOrigin: true,
          ws: true,
        },
      },
    },
    build: {
      target: "es2024",
    },
    plugins: [
      devtools({ consolePiping: { enabled: true } }),
      tsconfigPaths({ projects: ["./tsconfig.json"] }),
      tanstackStart({
        srcDirectory: "src/frontend",
        spa: {
          enabled: true,
          prerender: {
            // Emit the SPA shell at index.html so Cloudflare asset bindings can serve it natively.
            outputPath: "/index.html",
          },
        },
      }),
      tailwindcss(),
      viteReact(),
    ],
  };
});
