/**
 * The Vite plugins of a TanStack Start app on Workers (start-app.ts), which its vite.config.ts
 * hands Vite: the Cloudflare plugin with the app's Worker config (`startAppWorkerConfig`), TanStack
 * Start writing the route tree in `routeTreeStyle`, React and Tailwind.
 *
 * The app passes in its own plugin functions, imported in its vite.config.ts: they resolve from the
 * app's dependencies, as Vite itself does. Imported here they would resolve from scripts/, another
 * package, whose copies would load a second Vite beside the app's.
 */
import { routeTreeStyle, startAppWorkerConfig, type StartApp } from "./start-app.ts";

export function startAppVitePlugins<Cloudflare, Start, React, Tailwind>(
  app: StartApp,
  plugins: {
    cloudflare: (options: {
      viteEnvironment: { name: string };
      config: ReturnType<typeof startAppWorkerConfig>;
    }) => Cloudflare;
    tanstackStart: (options: {
      router: typeof routeTreeStyle & { basepath?: string };
      importProtection: { behavior: "error" };
    }) => Start;
    viteReact: () => React;
    tailwindcss: () => Tailwind;
  },
  /** TanStack Start's `router.basepath` (packages/notes routes under its own base path). */
  router: { basepath?: string } = {},
) {
  return [
    plugins.cloudflare({
      viteEnvironment: { name: "ssr" },
      config: startAppWorkerConfig(
        app,
        process.env.CLOUDFLARE_ENV,
        process.env.PUBLISHED_PACKAGE_COMMIT,
      ),
    }),
    plugins.tanstackStart({
      router: { ...router, ...routeTreeStyle },
      importProtection: { behavior: "error" },
    }),
    plugins.viteReact(),
    plugins.tailwindcss(),
  ];
}
