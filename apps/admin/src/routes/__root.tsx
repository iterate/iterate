import { createRootRoute, Outlet, Scripts, useHydrated } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { AppProviders } from "@iterate-com/ui/apps/providers";
import { EnvironmentHeadContent } from "@iterate-com/ui/components/environment-head-content";
import { startAppConfigOf } from "@iterate-com/shared/start-app-config";
import css from "../styles.css?url";
/** The worker's PostHog project key (`APP_CONFIG posthogProjectKey`: envs.ts, prd only). */
const posthogProjectKey = createServerFn().handler(async () => {
  const { env } = await import("cloudflare:workers");
  return startAppConfigOf(env).posthogProjectKey || null;
});

export const Route = createRootRoute({
  loader: () => posthogProjectKey(),
  staleTime: Infinity,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Admin" },
    ],
    links: [{ rel: "stylesheet", href: css }],
  }),
  component: Root,
});

function Root() {
  const apiKey = Route.useLoaderData();
  // false in the server's HTML, true once React owns the page: the specs' hydration-waiter
  // (specs/AGENTS.md) holds actions until then
  const hydrated = useHydrated();
  return (
    <html lang="en">
      <head>
        <EnvironmentHeadContent productionIcon="/client-logo.svg" />
      </head>
      <body className="min-h-svh bg-background font-sans antialiased" data-hydrated={hydrated}>
        <AppProviders posthogApiKey={apiKey || undefined}>
          <Outlet />
        </AppProviders>
        <Scripts />
      </body>
    </html>
  );
}
