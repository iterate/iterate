import { createRootRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { AppDocument } from "@iterate-com/ui/apps/document";
import { appHead } from "@iterate-com/ui/apps/head";
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
  head: () => appHead({ title: "Voice", stylesheet: css }),
  component: Root,
});

function Root() {
  const apiKey = Route.useLoaderData();
  return <AppDocument icon="/client-logo.svg" posthogProjectKey={apiKey} />;
}
