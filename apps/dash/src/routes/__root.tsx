import { createRootRoute, Outlet, Scripts, useHydrated } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { AppProviders } from "@iterate-com/ui/apps/providers";
import { EnvironmentHeadContent } from "@iterate-com/ui/components/environment-head-content";
import { startAppConfigOf } from "@iterate-com/shared/start-app-config";
import { appDirectory } from "../apps.ts";
import css from "../styles.css?url";
/** What the worker's `APP_CONFIG` says about this deployment: its PostHog project key (envs.ts,
 *  prd only) and its directory of apps (`urls`, apps.ts). */
const deployment = createServerFn().handler(async () => {
  const { env } = await import("cloudflare:workers");
  const config = startAppConfigOf(env);
  return {
    posthogProjectKey: config.posthogProjectKey || null,
    apps: appDirectory(config.urls),
  };
});

export const Route = createRootRoute({
  loader: () => deployment(),
  staleTime: Infinity,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: "Dash" },
    ],
    links: [{ rel: "stylesheet", href: css }],
  }),
  component: Root,
});

function Root() {
  const { posthogProjectKey } = Route.useLoaderData();
  // false in the server's HTML, true once React owns the page: the specs' hydration-waiter
  // (specs/AGENTS.md) holds actions until then
  const hydrated = useHydrated();
  return (
    <html lang="en">
      <head>
        <EnvironmentHeadContent productionIcon="/client-logo.svg" />
      </head>
      <body className="min-h-svh bg-background font-sans antialiased" data-hydrated={hydrated}>
        <AppProviders posthogApiKey={posthogProjectKey || undefined}>
          <Outlet />
        </AppProviders>
        <Scripts />
      </body>
    </html>
  );
}
