import { createRootRoute, HeadContent, Outlet, Scripts, useHydrated } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { AppProviders } from "@iterate-com/ui/apps/providers";
import { appDirectory } from "../apps.ts";
import css from "../styles.css?url";
/** What the worker's vars say about this deployment: its PostHog project key (envs.ts, prd only;
 *  `POSTHOG_PROJECT_KEY`) and its directory of apps (`ITERATE_APP_ORIGINS`, apps.ts). */
const deployment = createServerFn().handler(async () => {
  const { env } = await import("cloudflare:workers");
  return {
    posthogProjectKey: env.POSTHOG_PROJECT_KEY || null,
    apps: appDirectory(env.ITERATE_APP_ORIGINS),
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
        <HeadContent />
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
