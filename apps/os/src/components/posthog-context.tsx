import { useEffect, useRef } from "react";
import { useRouter } from "@tanstack/react-router";
import { useAuthClient } from "@iterate-com/auth/client";
import { capturePosthogPageview, syncPosthogContext } from "@iterate-com/ui/components/posthog";
import { osPosthogContext, type RouteProject } from "./posthog-context-model.ts";

/** Keep the browser SDK's persistent identity and groups aligned with routing. */
export function PosthogContextSync() {
  const { session } = useAuthClient();
  const router = useRouter();
  const capturedInitialPageview = useRef(false);

  useEffect(() => {
    if (session === null) return;
    const context = osPosthogContext(session, activeRouteProject(router));
    if (capturedInitialPageview.current) syncPosthogContext(context);
    else if (router.state.resolvedLocation?.href === router.state.location.href) {
      capturedInitialPageview.current = true;
      capturePosthogPageview(context, router.state.location.href);
    }
  }, [router, session]);

  useEffect(() => {
    return router.subscribe("onResolved", ({ hrefChanged, toLocation }) => {
      if (!hrefChanged || session === null) return;
      capturedInitialPageview.current = true;
      capturePosthogPageview(
        osPosthogContext(session, activeRouteProject(router)),
        toLocation.href,
      );
    });
  }, [router, session]);

  return null;
}

function activeRouteProject(router: ReturnType<typeof useRouter>): RouteProject | null {
  const match = router.state.matches.find(
    (candidate) => candidate.routeId === "/_app/projects/$projectSlug",
  );
  return (match?.context as { project?: RouteProject } | undefined)?.project ?? null;
}
