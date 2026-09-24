import { createRootRoute, HeadContent, Outlet, Scripts, useHydrated } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { AppProviders } from "@iterate-com/ui/apps/providers";
import css from "../styles.css?url";
/** This deployment's dash, where a person revokes a device's token: the worker's
 *  `ITERATE_APP_ORIGINS` (scripts/lib/start-app.ts — prd's from envs.ts; a per-PR preview's, the
 *  same PR's dash preview). Null when it names none: a preview run that did not deploy the dash,
 *  whose production dash would not know the preview's sessions. */
const dashOrigin = createServerFn().handler(async () => {
  const { env } = await import("cloudflare:workers");
  const origins = z.object({ dash: z.url().optional() }).parse(JSON.parse(env.ITERATE_APP_ORIGINS));
  return origins.dash || null;
});

export const Route = createRootRoute({
  loader: async () => ({ dashOrigin: await dashOrigin() }),
  staleTime: Infinity,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      {
        name: "description",
        content: "Install and configure an iterate voice device from your browser.",
      },
      { title: "iterate Kit" },
    ],
    links: [
      { rel: "stylesheet", href: css },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
    ],
  }),
  component: Root,
});

function Root() {
  // false in the server's HTML, true once React owns the page: the specs' hydration-waiter
  // (specs/AGENTS.md) holds actions until then
  const hydrated = useHydrated();
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="min-h-svh bg-background font-sans antialiased" data-hydrated={hydrated}>
        {/* light only, like every client app: no theme picker, no system theme */}
        <AppProviders>
          <Outlet />
        </AppProviders>
        <Scripts />
      </body>
    </html>
  );
}
