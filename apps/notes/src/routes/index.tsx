import { createFileRoute, Navigate } from "@tanstack/react-router";
import { DefaultPendingComponent } from "@iterate-com/ui/components/route-defaults";

/** `/` is the notes: the project's config worker signed the browser in before it reached Notes
 *  (config-worker.ts), so there is no landing page to sign in from. */
export const Route = createFileRoute("/")({
  component: () => (
    <>
      <Navigate to="/projects" replace />
      <DefaultPendingComponent />
    </>
  ),
});
