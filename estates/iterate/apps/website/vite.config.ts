import { defineConfig } from "vite";
import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  define: {
    "import.meta.env.POSTHOG_PUBLIC_KEY": `"${process.env.POSTHOG_PUBLIC_KEY}"`,
  },
  server: {
    port: 3000,
  },
  plugins: [reactRouter(), cloudflare({ viteEnvironment: { name: "ssr" } }), tailwindcss()],
});
