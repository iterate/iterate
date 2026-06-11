import { Suspense, useMemo } from "react";
import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import {
  createBrowserReplSession,
  ItxReplPage,
  type BrowserReplSessionFactory,
} from "~/routes/_app/itx-repl.tsx";
import { ItxActivityTail } from "~/components/itx-activity-tail.tsx";

const PROJECT_REPL_INITIAL_CODE = "await itx.describe()";

export const Route = createFileRoute("/_app/projects/$projectSlug/repl")({
  staticData: {
    breadcrumb: "Repl",
  },
  component: ProjectItxReplPage,
});

function TailConnecting() {
  return (
    <p className="border-t px-3 py-2 text-xs text-muted-foreground">Connecting itx activity...</p>
  );
}

function ProjectItxReplPage() {
  const { project } = Route.useRouteContext();
  // A project repl is just an itx session on that project's context — the
  // connect endpoint does the narrowing, the page is otherwise identical.
  const connectSession = useMemo<BrowserReplSessionFactory>(
    () => () => createBrowserReplSession(project.id),
    [project.id],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
        <ItxReplPage
          connectSession={connectSession}
          context="project"
          initialCode={PROJECT_REPL_INITIAL_CODE}
          scope={{ projectId: project.id }}
        />
      </div>
      <div className="flex max-h-56 min-h-0 flex-col">
        {/* useItx never SSRs and suspends until its socket connects, so the
            tail needs both gates: ClientOnly (this route still SSRs) and a
            Suspense boundary. */}
        <ClientOnly fallback={<TailConnecting />}>
          <Suspense fallback={<TailConnecting />}>
            <ItxActivityTail projectId={project.id} />
          </Suspense>
        </ClientOnly>
      </div>
    </div>
  );
}
