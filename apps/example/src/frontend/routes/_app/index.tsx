import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/")({
  beforeLoad: () => {
    throw Route.redirect({ to: "/debug", replace: true });
  },
});
