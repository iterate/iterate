import { defineConfig, loadEnv } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { z } from "zod";

const env = z
  .object({
    PORT: z.coerce.number().int().positive().default(17301),
    API_BASE_URL: z.string().default("http://127.0.0.1:17302"),
  })
  .parse(process.env);

export default defineConfig(() => {
  return {
    server: {
      host: true,
      port: env.PORT,
      strictPort: false,
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
    plugins: [
      // see tanstack start browser console in
      devtools({ consolePiping: { enabled: true } }),
      tsconfigPaths({ projects: ["./tsconfig.json"] }),
      tanstackStart({
        srcDirectory: "src/frontend",
        spa: { enabled: true },
      }),
      tailwindcss(),
      viteReact(),
    ],
  };
});
