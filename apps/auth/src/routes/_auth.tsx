import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

// Only user-facing fields cross to the client. The raw better-auth session
// object also carries `session.token` — the bearer-equivalent of the HttpOnly
// session cookie — which must never end up in router context or dehydrated
// loader payloads.
const getSessionUser = createServerFn().handler(({ context }) => {
  const { session } = context.variables;
  if (!session) return null;
  return { user: session.user };
});

export const Route = createFileRoute("/_auth")({
  beforeLoad: async ({ location }) => {
    const session = await getSessionUser();
    if (!session) throw redirect({ to: "/login", search: { redirect: location.href } });
    return { session };
  },
});
