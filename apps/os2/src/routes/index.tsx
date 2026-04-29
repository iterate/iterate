import { createFileRoute, redirect } from "@tanstack/react-router";
import { requireActiveOrganizationForRoute } from "../lib/auth.ts";

export const Route = createFileRoute("/")({
  loader: async () => {
    await requireActiveOrganizationForRoute();
    throw redirect({ to: "/debug", replace: true });
  },
});
