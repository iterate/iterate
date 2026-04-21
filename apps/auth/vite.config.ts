import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import alchemy from "alchemy/cloudflare/vite";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";

export default defineConfig({
  server: {
    cors: {
      origin: (origin, cb) => cb(null as unknown as Error, origin ?? true),
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    },
  },
  plugins: [
    alchemy({
      viteEnvironment: { name: "ssr" },
    }),
    tailwindcss(),
    tanstackStart({
      router: { addExtensions: true, semicolons: true, quoteStyle: "double" },
      importProtection: { behavior: "error" },
    }),
    viteReact(),
  ],
  clearScreen: false,
});
