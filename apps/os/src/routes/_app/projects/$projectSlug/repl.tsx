import { createFileRoute } from "@tanstack/react-router";
import { ItxActivityTail } from "~/components/itx-activity-tail.tsx";
import { ItxScopeRepl } from "~/components/itx-scope-repl.tsx";

const PROJECT_REPL_INITIAL_CODE = "return await itx.__describe()";

/** The project's ONE shared REPL scope — a singleton like /scheduler/primary,
 * so the stream has a guessable name and teammates share one Out[n] history
 * and one set of pinned preamble helpers. Stable addressing
 * (results.byOffset) exists because positions shift in a shared scope. */
const PROJECT_REPL_SCOPE_PATH = "/repl";

export const Route = createFileRoute("/_app/projects/$projectSlug/repl")({
  staticData: {
    breadcrumb: "Repl",
  },
  component: ProjectItxReplPage,
});

function ProjectItxReplPage() {
  const { project } = Route.useRouteContext();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
        <ItxScopeRepl
          initialCode={PROJECT_REPL_INITIAL_CODE}
          projectId={project.id}
          scopePath={PROJECT_REPL_SCOPE_PATH}
        />
      </div>
      {/* useStreamConnection never suspends, and the route is client-only, so the
          activity tail needs no ClientOnly/Suspense wrapper. */}
      <div className="flex max-h-56 min-h-0 flex-col">
        {/* Tail the scope the REPL actually journals on — runs, provides,
            revokes all land on /repl, not the project root. */}
        <ItxActivityTail key={project.id} path={PROJECT_REPL_SCOPE_PATH} />
      </div>
    </div>
  );
}
