import { createRootRoute, Outlet, Scripts, useHydrated } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { AppProviders } from "@iterate-com/ui/apps/providers";
import { EnvironmentHeadContent } from "@iterate-com/ui/components/environment-head-content";
import { startAppConfigOf } from "@iterate-com/shared/start-app-config";
import css from "../styles.css?url";
/** What the worker's `APP_CONFIG` says about this deployment: its PostHog project key (envs.ts, prd
 *  only) and its dash, where a person revokes a device's token (`urls.dash`: prd's from envs.ts; a
 *  per-PR preview's, the same PR's dash preview). `dashOrigin` is null when it names none: a
 *  preview run that did not deploy the dash, whose production dash would not know the preview's
 *  sessions. */
const deployment = createServerFn().handler(async () => {
  const { env } = await import("cloudflare:workers");
  const config = startAppConfigOf(env);
  return {
    posthogProjectKey: config.posthogProjectKey || null,
    dashOrigin: config.urls.dash || null,
  };
});

export const Route = createRootRoute({
  loader: () => deployment(),
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
        <EnvironmentHeadContent productionIcon="/favicon.svg" />
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
