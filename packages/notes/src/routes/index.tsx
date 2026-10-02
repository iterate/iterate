import { createFileRoute, redirect } from "@tanstack/react-router";

/** `/` is the notes: the project's config worker signed the browser in before it reached Notes
 *  (config-worker.ts), so there is no landing page to sign in from. */
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/projects", replace: true });
  },
});
