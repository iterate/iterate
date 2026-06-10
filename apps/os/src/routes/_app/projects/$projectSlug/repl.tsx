import { useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  createBrowserReplSession,
  ItxReplPage,
  type BrowserReplSessionFactory,
} from "~/routes/_app/itx-repl.tsx";

const PROJECT_REPL_INITIAL_CODE = "await itx.describe()";

export const Route = createFileRoute("/_app/projects/$projectSlug/repl")({
  staticData: {
    breadcrumb: "Repl",
  },
  component: ProjectItxReplPage,
});

function ProjectItxReplPage() {
  const { project } = Route.useRouteContext();
  // A project repl is just an itx session on that project's context — the
  // connect endpoint does the narrowing, the page is otherwise identical.
  const connectSession = useMemo<BrowserReplSessionFactory>(
    () => () => createBrowserReplSession(project.id),
    [project.id],
  );

  return (
    <ItxReplPage
      connectSession={connectSession}
      initialCode={PROJECT_REPL_INITIAL_CODE}
      scope={{ projectId: project.id }}
    />
  );
}
