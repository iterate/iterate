import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { writeWranglerConfig } from "../../scripts/lib/start-app.ts";
import { writeVoiceInstall } from "../agents/scripts/build-voice-install.ts";
import { voice } from "./scripts/app.ts";

writeWranglerConfig(voice);
// The install the page runs for a project with no voice agent, served at /voice-install.json.
await writeVoiceInstall(new URL("./public/voice-install.json", import.meta.url));
export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    {
      name: "voice:emitted-wrangler-config",
      closeBundle() {
        const path = "dist/server/wrangler.json";
        if (!existsSync(path)) return;
        // Vite's older Wrangler still emits the removed default field.
        const { legacy_env: _removed, ...config } = JSON.parse(readFileSync(path, "utf8"));
        writeFileSync(path, JSON.stringify(config));
      },
    },
    tanstackStart({
      router: { addExtensions: true, semicolons: true, quoteStyle: "double" },
      importProtection: { behavior: "error" },
    }),
    viteReact(),
    tailwindcss(),
  ],
});
