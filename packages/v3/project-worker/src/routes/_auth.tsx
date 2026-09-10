// _auth.tsx — the signed-in layout: no session ⇒ `/login?next=<here>`; the session rides the router
// context to every route under it (`/`, `/authorize`).
import { createFileRoute, redirect } from "@tanstack/react-router";
import { sessionOf } from "./-session.ts";

export const Route = createFileRoute("/_auth")({
  beforeLoad: async ({ location }) => {
    const session = await sessionOf();
    if (!session) throw redirect({ to: "/login", search: { next: location.href } });
    return { session };
  },
});
