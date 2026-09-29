import { createFileRoute, redirect } from "@tanstack/react-router";

/** `/` is the docs list: the project's members-only route to Docs signed the browser in before it
 *  reached Docs, so there is no landing page to sign in from. */
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/projects", replace: true });
  },
});
