import { createFileRoute, redirect } from "@tanstack/react-router";
import { requireAuthenticatedRootRedirectTarget } from "../lib/auth.ts";

export const Route = createFileRoute("/")({
  loader: async () => {
    await requireAuthenticatedRootRedirectTarget();

    throw redirect({
      to: "/projects",
      replace: true,
    });
  },
});
