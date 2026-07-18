import { useEffect, useMemo, useRef } from "react";
import { useMatches } from "@tanstack/react-router";
import { useAuthClient } from "@iterate-com/auth/client";
import { resetPosthogIdentity, syncPosthogContext } from "@iterate-com/ui/components/posthog";
import { osPosthogContext, type RouteProject } from "./posthog-context-model.ts";

/** Keep the browser SDK's persistent identity and groups aligned with routing. */
export function PosthogContextSync() {
  const { session } = useAuthClient();
  const matches = useMatches();
  const project = useMemo(() => {
    let activeProject: RouteProject | null = null;
    for (const match of matches) {
      const { context } = match;
      if (typeof context !== "object" || context === null || !("project" in context)) continue;
      const candidate = context.project;
      if (isRouteProject(candidate)) activeProject = candidate;
    }
    return activeProject;
  }, [matches]);
  const previousUserId = useRef<string | null | undefined>(undefined);
  const previousContextKey = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (session === null) return;

    const context = osPosthogContext(session, project);
    if (!context) {
      // Do not reset a brand-new anonymous browser. On an actual sign-out,
      // however, reset severs the old person's distinct ID and clears groups.
      if (typeof previousUserId.current === "string") resetPosthogIdentity();
      previousUserId.current = null;
      previousContextKey.current = undefined;
      return;
    }

    const contextKey = JSON.stringify(context);
    const resetIdentity =
      typeof previousUserId.current === "string" &&
      previousUserId.current !== context.person.distinctId;
    if (!resetIdentity && previousContextKey.current === contextKey) return;

    syncPosthogContext({ ...context, resetIdentity });
    previousUserId.current = context.person.distinctId;
    previousContextKey.current = contextKey;
  }, [project, session]);

  return null;
}

function isRouteProject(value: unknown): value is RouteProject {
  if (typeof value !== "object" || value === null) return false;
  return (
    "id" in value &&
    typeof value.id === "string" &&
    "slug" in value &&
    typeof value.slug === "string" &&
    "organizationId" in value &&
    (typeof value.organizationId === "string" || value.organizationId === null)
  );
}
