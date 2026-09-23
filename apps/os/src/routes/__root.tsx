import { createRootRoute, HeadContent, Outlet, Scripts, useHydrated } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useEffect } from "react";
import css from "../styles.css?url";

/** The worker's PostHog project key (envs.ts, prd only; wrangler var `POSTHOG_PROJECT_KEY`). */
const posthogProjectKey = createServerFn().handler(async () => {
  const { env } = await import("cloudflare:workers");
  return (env as { POSTHOG_PROJECT_KEY?: string }).POSTHOG_PROJECT_KEY || null;
});

export const Route = createRootRoute({
  loader: () => posthogProjectKey(),
  staleTime: Infinity,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
    ],
    links: [
      { rel: "stylesheet", href: css },
      { rel: "icon", href: "/iterate-logo.svg", type: "image/svg+xml" },
    ],
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
        <HeadContent />
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
