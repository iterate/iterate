import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { AppProviders } from "@iterate-com/ui/apps/providers";
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
      { title: "Agents" },
    ],
    links: [{ rel: "stylesheet", href: css }],
  }),
  component: Root,
});

function Root() {
  const apiKey = Route.useLoaderData();
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="min-h-svh bg-background font-sans antialiased">
        {/* light only, like every os-next app: no theme picker, no system theme */}
        <AppProviders
          config={{}}
          devtools={null}
          forcedTheme="light"
          posthog={{ apiKey: apiKey || undefined }}
        >
          <Outlet />
        </AppProviders>
        <Scripts />
      </body>
    </html>
  );
}
