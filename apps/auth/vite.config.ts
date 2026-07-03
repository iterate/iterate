import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { writeWranglerConfig } from "./scripts/generate-wrangler-config.ts";

// wrangler.jsonc is generated (gitignored) — refresh it from envs.ts before
// the cloudflare plugin reads it, so dev and build can never see stale config.
writeWranglerConfig();

const authAppOrigin = process.env.APP_CONFIG_AUTH_APP_ORIGIN?.trim() ?? "";

export default defineConfig({
  define: {
    __AUTH_APP_ORIGIN__: JSON.stringify(authAppOrigin),
  },
  server: {
    cors: {
      origin: (origin, cb) => cb(null as unknown as Error, origin ?? true),
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    },
  },
  plugins: [
    // The worker (src/server/worker.ts) runs in workerd during dev;
    // wrangler.jsonc (generated from the root envs.ts) declares its bindings,
    // and the keys in its `secrets.required` load straight from process.env —
    // which is why `doppler run -- vite dev` needs no .dev.vars file.
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    tanstackStart({
      router: { addExtensions: true, semicolons: true, quoteStyle: "double" },
      importProtection: { behavior: "error" },
    }),
    viteReact(),
  ],
  clearScreen: false,
});
