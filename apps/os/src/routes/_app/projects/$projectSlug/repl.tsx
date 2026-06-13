import { Suspense } from "react";
import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import { ItxReplConnecting, ItxReplPage } from "~/routes/_app/itx-repl.tsx";
import { ItxActivityTail } from "~/components/itx-activity-tail.tsx";
import { useItx } from "~/itx/use-itx.ts";

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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
        {/* useItx never SSRs and suspends until its socket connects, so the
            repl needs both gates: ClientOnly (this route still SSRs) and a
            Suspense boundary. */}
        <ClientOnly fallback={<ItxReplConnecting />}>
          <Suspense fallback={<ItxReplConnecting />}>
            <ProjectReplConnected projectId={project.id} />
          </Suspense>
        </ClientOnly>
      </div>
      <div className="flex max-h-56 min-h-0 flex-col">
        <ClientOnly fallback={<TailConnecting />}>
          <Suspense fallback={<TailConnecting />}>
            <ItxActivityTail projectId={project.id} />
          </Suspense>
        </ClientOnly>
      </div>
    </div>
  );
}

function ProjectReplConnected({ projectId }: { projectId: string }) {
  // A project repl is just an itx session on that project's context — the same
  // pooled socket every other component on this project rides (useItx narrows
  // by context = the connect endpoint). The page is otherwise identical.
  const itx = useItx(projectId);
  return (
    <ItxReplPage
      itx={itx}
      context="project"
      initialCode={PROJECT_REPL_INITIAL_CODE}
      scope={{ projectId }}
    />
  );
}
