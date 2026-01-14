import path from "node:path";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import alchemy from "alchemy/cloudflare/tanstack-start";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { devtools } from "@tanstack/devtools-vite";
import cloudflareTunnel from "vite-plugin-cloudflare-tunnel";
import { getTunnelConfig } from "@iterate-com/shared/dev-utils";

const appName = path.basename(process.cwd());
const stage =
  process.env.STAGE ?? (process.env.ITERATE_USER ? `dev-${process.env.ITERATE_USER}` : undefined);
const tunnelConfig = getTunnelConfig(appName, stage);

export default defineConfig(({ command }) => {
  // Set VITE_PUBLIC_URL to Cloudflare Tunnel hostname in dev mode
  if (tunnelConfig && command === "serve") {
    process.env.VITE_PUBLIC_URL = `https://${tunnelConfig.hostname}`;
  }

  return {
    resolve: {
      dedupe: ["react", "react-dom"],
    },
    build: {
      sourcemap: true,
      minify: "terser",
      terserOptions: {
        mangle: false,
      },
    },
    server: {
      allowedHosts: [".dev.iterate.com"],
      cors: false,
      strictPort: false,
    },
    preview: {
      port: 5174,
    },
    plugins: [
      cloudflareTunnel({
        enabled: !!tunnelConfig,
        hostname: tunnelConfig?.hostname ?? "",
        tunnelName: tunnelConfig?.tunnelName ?? "",
        apiToken: process.env.CLOUDFLARE_API_TOKEN,
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
        cleanup: { autoCleanup: false },
      }),
      devtools({
        eventBusConfig: {
          // Port 0 enables auto-assigned port (default behavior)
          port: 0,
        },
      }),
      alchemy(),
      tailwindcss(),
      tanstackStart({
        srcDirectory: "./app",
        router: {
          addExtensions: true,
          virtualRouteConfig: "./app/routes.ts",
        },
      }),
      viteReact(),
    ],
    define: {
      "import.meta.vitest": "undefined",
    },
  };
});
