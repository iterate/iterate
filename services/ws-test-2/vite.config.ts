import { defineConfig, loadEnv } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

function createApiProxy(targetPort: number | undefined) {
  if (!targetPort) {
    return undefined;
  }

  return {
    "/api": {
      target: `http://127.0.0.1:${targetPort}`,
      changeOrigin: true,
      ws: true,
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const configuredPort = process.env.PORT?.trim() ? Number(process.env.PORT) : 0;
  const backendPort = env.VITE_BACKEND_PORT?.trim() ? Number(env.VITE_BACKEND_PORT) : undefined;
  const apiProxy = createApiProxy(backendPort);

  return {
    plugins: [
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
      port: configuredPort || 0,
      strictPort: Boolean(configuredPort),
      proxy: apiProxy,
    },
    preview: {
      host: true,
      port: configuredPort || 4173,
      strictPort: Boolean(configuredPort),
      proxy: apiProxy,
    },
  };
});
