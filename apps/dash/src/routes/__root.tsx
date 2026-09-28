import { createRootRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { AppDocument } from "@iterate-com/ui/apps/document";
import { appHead } from "@iterate-com/ui/apps/head";
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
  head: () => appHead({ title: "Dash", stylesheet: css }),
  component: Root,
});

function Root() {
  const { posthogProjectKey } = Route.useLoaderData();
  return <AppDocument icon="/client-logo.svg" posthogProjectKey={posthogProjectKey} />;
}
