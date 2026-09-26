import { createRootRouteWithContext, Outlet, Scripts, useHydrated } from "@tanstack/react-router";
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

/** `basePath`: the path this page is served under, "" on Notes' own origin (base-path.ts). */
export const Route = createRootRouteWithContext<{ basePath: string }>()({
  loader: () => posthogProjectKey(),
  staleTime: Infinity,
  head: ({ match }) => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Notes" },
    ],
    links: [{ rel: "stylesheet", href: `${match.context.basePath}${css}` }],
  }),
  component: Root,
});

function Root() {
  const apiKey = Route.useLoaderData();
  const { basePath } = Route.useRouteContext();
  // false in the server's HTML, true once React owns the page: the specs' hydration-waiter
  // (specs/AGENTS.md) holds actions until then
  const hydrated = useHydrated();
  return (
    // the browser's router reads the base path here before it starts (base-path.ts)
    <html lang="en" data-base-path={basePath || undefined}>
      <head>
        <EnvironmentHeadContent productionIcon={`${basePath}/client-logo.svg`} />
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
