import { createFileRoute, notFound } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth/admin")({
  beforeLoad: ({ context }) => {
    if (context.session.user.role !== "admin")
      throw notFound({ data: { message: "Not authorized" } });
  },
});
