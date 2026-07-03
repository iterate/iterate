import { createFileRoute, redirect } from "@tanstack/react-router";

// /admin has no content of its own yet; clients is the only admin page.
export const Route = createFileRoute("/_auth/admin/")({
  beforeLoad: () => {
    throw redirect({ to: "/admin/clients" });
  },
});
