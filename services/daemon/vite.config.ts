import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const daemonServicePort = process.env.DAEMON_SERVICE_PORT ?? "3001";

export default defineConfig({
  base: "/terminal/",
  plugins: [react()],
  build: {
    outDir: "client-dist",
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${daemonServicePort}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  preview: {
    port: 3000,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${daemonServicePort}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
