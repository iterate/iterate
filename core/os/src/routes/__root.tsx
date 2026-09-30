import { createRootRoute, Outlet, Scripts, useHydrated } from "@tanstack/react-router";
import { EnvironmentHeadContent } from "../components/environment-head-content.tsx";
import { initPosthog } from "../components/posthog.tsx";
import { getPosthogProjectKey } from "../issuer.functions.ts";
import css from "../styles.css?url";

export const Route = createRootRoute({
  loader: () => getPosthogProjectKey(),
  staleTime: Infinity,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
    ],
    links: [{ rel: "stylesheet", href: css }],
  }),
  component: RootDocument,
});

/** The sign-in and consent pages: core/os's own PostHog init (components/posthog.tsx), anonymous — the
 *  person is identified in the apps they sign in to (dash), and PostHog's shared `*.iterate.com`
 *  cookie joins this visit to them. */
function RootDocument() {
  // `data-hydrated` is false in the server's HTML and true once React owns the page: the specs'
  // hydration-waiter (test/playwright/AGENTS.md) waits on it before touching controls that do nothing yet.
  const hydrated = useHydrated();
  const apiKey = Route.useLoaderData();
  initPosthog(apiKey);
  return (
    <html lang="en">
      <head>
        <EnvironmentHeadContent productionIcon="/iterate-logo.svg" />
      </head>
      <body
        className="min-h-svh bg-background font-sans text-foreground antialiased"
        data-hydrated={hydrated}
      >
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
