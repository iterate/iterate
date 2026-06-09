import { createFileRoute, redirect } from "@tanstack/react-router";
import { requireAuthenticatedRootRedirectTargetFromSession } from "../lib/auth.ts";

export const Route = createFileRoute("/")({
  loader: ({ context, location }) => {
    const target = requireAuthenticatedRootRedirectTargetFromSession(
      context.authSession,
      location,
      context.currentProjectHostSlug,
    );
    if (target.projectSlug) {
      throw redirect({
        to: "/projects/$projectSlug/codemode-sessions/new",
        params: { projectSlug: target.projectSlug },
        replace: true,
      });
    }

    throw redirect({ to: "/projects", replace: true });
  },
});
