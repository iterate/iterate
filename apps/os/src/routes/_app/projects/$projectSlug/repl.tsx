import { createFileRoute } from "@tanstack/react-router";
import { useAuthClient } from "@iterate-com/auth/client";
import { ItxActivityTail } from "~/components/itx-activity-tail.tsx";
import { ItxScopeRepl } from "~/components/itx-scope-repl.tsx";

const PROJECT_REPL_INITIAL_CODE = "return await itx.__describe()";

export const Route = createFileRoute("/_app/projects/$projectSlug/repl")({
  staticData: {
    breadcrumb: "Repl",
  },
  component: ProjectItxReplPage,
});

function ProjectItxReplPage() {
  const { project } = Route.useRouteContext();
  const { session } = useAuthClient();
  // _app.beforeLoad guarantees an authenticated member; this is the SSR-safe
  // read of the same session the layout already validated.
  if (!session?.authenticated) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
        {/* Runs execute as scope scripts in a per-user scope: the auth
            user id is the stable identifier the web session exposes (slugs and
            emails can change), so the scope path is /repl/<user-id>. */}
        <ItxScopeRepl
          initialCode={PROJECT_REPL_INITIAL_CODE}
          projectId={project.id}
          scopePath={`/repl/${session.user.id}`}
        />
      </div>
      {/* useStreamConnection never suspends, and the route is client-only, so the
          activity tail needs no ClientOnly/Suspense wrapper. */}
      <div className="flex max-h-56 min-h-0 flex-col">
        <ItxActivityTail />
      </div>
    </div>
  );
}
