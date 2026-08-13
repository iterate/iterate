import { useEffect, useRef } from "react";
import { useMatch, useRouterState } from "@tanstack/react-router";
import { useAuthClient } from "@iterate-com/auth/client";
import { capturePosthogPageview, syncPosthogContext } from "@iterate-com/ui/components/posthog";
import { osPosthogContext } from "./posthog-context-model.ts";

/** Keep the browser SDK's persistent identity and groups aligned with routing. */
export function PosthogContextSync() {
  const { session } = useAuthClient();
  const href = useRouterState({ select: (state) => state.location.href });
  const resolvedHref = useRouterState({ select: (state) => state.resolvedLocation?.href });
  const projectRouteMatched = useRouterState({
    select: (state) =>
      state.matches.some((match) => match.routeId === "/_app/projects/$projectSlug"),
  });
  const project = useMatch({
    from: "/_app/projects/$projectSlug",
    shouldThrow: false,
    select: (match) => match.context.project,
  });
  const capturedPageviewHref = useRef<string | null>(null);

  useEffect(() => {
    if (!session || href !== resolvedHref || (projectRouteMatched && !project)) return;
    const context = osPosthogContext(session, project ?? null);
    if (capturedPageviewHref.current === href) syncPosthogContext(context);
    else {
      capturedPageviewHref.current = href;
      capturePosthogPageview(context, href);
    }
  }, [href, project, projectRouteMatched, resolvedHref, session]);

  return null;
}
