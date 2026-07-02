import { createFileRoute, notFound } from "@tanstack/react-router";
import { isPlatformAdminUser } from "../../server/platform-admin.ts";

// Guard-only layout for /admin/*. notFound (not 403) on purpose: don't
// confirm to non-admins that an admin area exists.
export const Route = createFileRoute("/_auth/admin")({
  beforeLoad: ({ context }) => {
    if (!isPlatformAdminUser(context.session.user)) {
      throw notFound();
    }
  },
});
