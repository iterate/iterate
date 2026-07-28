import { createFileRoute } from "@tanstack/react-router";
import { ConnectedItxRepl } from "~/routes/_app/itx-repl.tsx";
import { ItxActivityTail } from "~/components/itx-activity-tail.tsx";
const PROJECT_REPL_INITIAL_CODE = "await itx.__describe()";

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
        {/* A project repl is just the project itx (session.projects.get) — the
            one session socket every other component on this tab rides. */}
        <ConnectedItxRepl
          poolContext={project.id}
          context="project"
          initialCode={PROJECT_REPL_INITIAL_CODE}
          scope={{ projectId: project.id }}
        />
      </div>
      {/* useItxSubscription connects from an effect and never suspends, so the
          activity tail is safe in the server-rendered project shell. */}
      <div className="flex max-h-56 min-h-0 flex-col">
        <ItxActivityTail />
      </div>
    </div>
  );
}
