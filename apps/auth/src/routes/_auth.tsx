import { createFileRoute, redirect } from "@tanstack/react-router";
import { authClient } from "../utils/auth-client.ts";

export const Route = createFileRoute("/_auth")({
  beforeLoad: async ({ location }) => {
    const session = await authClient.getSession().catch(() => null);
    const url = location.href + location.searchStr;
    if (!session) throw redirect({ to: "/login", search: { redirect: url } });
    return { session };
  },
});
