import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import alchemy from "alchemy/cloudflare/vite";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";

export default defineConfig({
  plugins: [
    alchemy({
      viteEnvironment: { name: "ssr" },
    }),
    tailwindcss(),
    tanstackStart({
      spa: { enabled: true },
      router: { addExtensions: true, semicolons: true, quoteStyle: "double" },
      importProtection: { behavior: "error" },
    }),
    viteReact(),
  ],
  clearScreen: false,
});
