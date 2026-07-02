import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { StreamPath } from "~/lib/stream-links.ts";
import { ProjectCreationProgress } from "~/components/project-creation-progress.tsx";
import { ProjectSettingsPanel } from "~/components/project-settings-panel.tsx";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import { getPublicRouteConfig } from "~/lib/public-route-config.ts";
import { useProjectProcessorState } from "~/lib/project-processor-state.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/")({
  ssr: false,
  loader: async ({ context }) => {
    return {
      breadcrumb: "Home",
      project: context.project,
      routeConfig: await getPublicRouteConfig(),
    };
  },
  component: ProjectHomePage,
});

/**
 * The project home renders the REDUCED STATE, live — that is the primary view.
 * Until the bootstrap saga commits `project/created`, that render is the
 * creation checklist (create redirects here immediately, before the saga
 * finishes, and every tick arrives as a processor push); afterwards it is the
 * settings view plus the raw fold for the curious. The event stream is the
 * secondary view, tucked behind a toggle.
 */
function ProjectHomePage() {
  const params = Route.useParams();
  const { project, routeConfig } = Route.useLoaderData();
  const lifecycle = useProjectProcessorState(project.id);
  const created = lifecycle.state.created;

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6">
        {created ? (
          <>
            <ProjectSettingsPanel project={project} routeConfig={routeConfig} />
            <details className="rounded-lg border">
              <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">
                Reduced state
                <span className="ml-2 font-normal text-muted-foreground">
                  project lifecycle processor, offset {lifecycle.offset}
                </span>
              </summary>
              <pre className="max-h-[24rem] overflow-auto border-t bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
                {JSON.stringify({ offset: lifecycle.offset, state: lifecycle.state }, null, 2)}
              </pre>
            </details>
          </>
        ) : (
          <ProjectCreationProgress state={lifecycle.state} />
        )}

        <ProjectEventStreamSection projectId={project.id} projectSlug={params.projectSlug} />
      </div>
    </section>
  );
}

/**
 * The raw event stream, positioned as the secondary view: collapsed by
 * default, and only mounted (it hosts a browser-side SQLite mirror) once
 * opened.
 */
function ProjectEventStreamSection({
  projectId,
  projectSlug,
}: {
  projectId: string;
  projectSlug: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <section className="flex min-h-0 flex-col rounded-lg border" data-testid="project-event-stream">
      <Button
        type="button"
        variant="ghost"
        className="justify-start gap-2 px-4 py-3 text-sm font-semibold"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? (
          <ChevronDownIcon aria-hidden="true" data-icon="icon" />
        ) : (
          <ChevronRightIcon aria-hidden="true" data-icon="icon" />
        )}
        Event stream
        <span className="font-normal text-muted-foreground">project root</span>
      </Button>
      {open ? (
        <div className="flex h-[32rem] min-h-0 flex-col border-t">
          <ProjectStreamView
            emptyLabel="No events in the project root stream yet."
            projectSlug={projectSlug}
            projectId={projectId}
            streamPath={StreamPath.parse("/")}
          />
        </div>
      ) : null}
    </section>
  );
}
