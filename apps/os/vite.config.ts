import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import alchemy from "alchemy/cloudflare/tanstack-start";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { devtools } from "@tanstack/devtools-vite";
import { cloudflareTunnel, getTunnelHostname } from "@iterate-com/shared/cloudflare-tunnel";

export default defineConfig(({ command }) => {
  // Set VITE_PUBLIC_URL to Cloudflare Tunnel hostname in dev mode
  const tunnelHostname = getTunnelHostname(import.meta.dirname);
  if (tunnelHostname && command === "serve") {
    process.env.VITE_PUBLIC_URL = `https://${tunnelHostname}`;
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
      cors: false,
      strictPort: false,
    },
    plugins: [
      cloudflareTunnel(import.meta.dirname),
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
