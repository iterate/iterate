import { defineConfig, loadEnv } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

const DEFAULT_FRONTEND_PORT = 17301;
const DEFAULT_API_PORT = 17302;

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const frontendPort = env.PORT?.trim() ? Number(env.PORT) : DEFAULT_FRONTEND_PORT;
  const apiBaseUrl =
    process.env.API_BASE_URL?.trim() ||
    env.API_BASE_URL?.trim() ||
    `http://127.0.0.1:${DEFAULT_API_PORT}`;

  return {
    plugins: [
      devtools({ consolePiping: { enabled: true } }),
      tsconfigPaths({ projects: ["./tsconfig.json"] }),
      tanstackStart({
        srcDirectory: "src/frontend",
        spa: { enabled: true },
      }),
      tailwindcss(),
      viteReact(),
    ],
    server: {
      host: true,
      port: frontendPort,
      strictPort: true,
      proxy: {
        "/api": {
          target: apiBaseUrl,
          changeOrigin: true,
          ws: true,
        },
      },
    },
    preview: {
      host: true,
      port: frontendPort,
      strictPort: true,
      proxy: {
        "/api": {
          target: apiBaseUrl,
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});
