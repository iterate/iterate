import { createFileRoute, redirect } from "@tanstack/react-router";
import { authClient } from "../utils/auth-client.ts";

export const Route = createFileRoute("/_auth")({
  beforeLoad: async ({ location }) => {
    const session = await authClient.getSession().catch(() => null);
    if (!session) throw redirect({ to: "/login", search: { redirect: location.href } });
    return { session };
  },
});
