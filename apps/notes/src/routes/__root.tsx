import { createRootRouteWithContext } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { AppDocument } from "@iterate-com/ui/apps/document";
import { appHead } from "@iterate-com/ui/apps/head";
import { startAppConfigOf } from "@iterate-com/shared/start-app-config";
import { underBasePath } from "@iterate-com/ui/apps/base-path";
import css from "../styles.css?url";
/** The worker's PostHog project key (`APP_CONFIG posthogProjectKey`: envs.ts, prd only). */
const posthogProjectKey = createServerFn().handler(async () => {
  const { env } = await import("cloudflare:workers");
  return startAppConfigOf(env).posthogProjectKey || null;
});

/** `basePath`: the path this page is served under, "" on a project host of its own (@iterate-com/ui/apps/base-path). */
export const Route = createRootRouteWithContext<{ basePath: string }>()({
  loader: () => posthogProjectKey(),
  staleTime: Infinity,
  head: ({ match }) =>
    appHead({ title: "Notes", stylesheet: underBasePath(match.context.basePath, css) }),
  component: Root,
});

function Root() {
  const { basePath } = Route.useRouteContext();
  return (
    <AppDocument
      icon="/client-logo.svg"
      basePath={basePath}
      posthogProjectKey={Route.useLoaderData()}
    />
  );
}
