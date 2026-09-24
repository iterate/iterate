import { createRootRoute, Outlet, Scripts, useHydrated } from "@tanstack/react-router";
import { useEffect } from "react";
import { EnvironmentHeadContent } from "@iterate-com/ui/components/environment-head-content";
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

/** The sign-in and consent pages: pageviews and session replay, anonymous — the person is
 *  identified in the apps they sign in to (dash), and PostHog's shared `*.iterate.com` cookie joins
 *  this visit to them. posthog-js directly, not packages/ui's setup: this worker's type program has
 *  no DOM. Same settings: through `/e` (worker.ts), EU, nothing masked. */
function RootDocument() {
  // `data-hydrated` is false in the server's HTML and true once React owns the page: the specs'
  // hydration-waiter (specs/AGENTS.md) waits on it before touching controls that do nothing yet.
  const hydrated = useHydrated();
  const apiKey = Route.useLoaderData();
  useEffect(() => {
    if (!apiKey) return;
    void import("posthog-js").then(({ default: posthog }) =>
      posthog.init(apiKey, {
        api_host: "/e",
        ui_host: "https://eu.posthog.com",
        defaults: "2026-06-25",
        person_profiles: "identified_only",
        session_recording: { maskAllInputs: false },
      }),
    );
  }, [apiKey]);
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
