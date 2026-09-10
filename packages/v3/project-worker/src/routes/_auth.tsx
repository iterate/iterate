// Console pages require the console host’s ordinary OAuth browser grant.
import { createFileRoute, redirect } from "@tanstack/react-router";
import { sessionOf } from "./-session.ts";

export const Route = createFileRoute("/_auth")({
  beforeLoad: async ({ location }) => {
    const session = await sessionOf();
    if (!session)
      throw redirect({ href: `/.auth/login?next=${encodeURIComponent(location.href)}` });
    return { session };
  },
});
