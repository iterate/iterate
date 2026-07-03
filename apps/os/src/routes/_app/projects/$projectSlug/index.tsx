import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { StreamPath } from "~/lib/stream-links.ts";
import { ProjectCreationProgress } from "~/components/project-creation-progress.tsx";
import { ProjectSettingsPanel } from "~/components/project-settings-panel.tsx";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import { getPublicRouteConfig } from "~/lib/public-route-config.ts";
import { useItxState } from "~/itx/itx-react.tsx";
import type { ProjectProcessorState } from "~/types.ts";

const HomeSearch = z.object({
  /** Set by the create form: play the creation checklist, then hand over to
   * the onboarding agent the moment the bootstrap saga lands. */
  welcome: z.boolean().optional().catch(undefined),
});

export const Route = createFileRoute("/_app/projects/$projectSlug/")({
  validateSearch: HomeSearch,
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
  const { project, routeConfig } = Route.useLoaderData();
  const { welcome } = Route.useSearch();
  const params = Route.useParams();
  const navigate = useNavigate();
  const lifecycle = useItxState<ProjectProcessorState>(
    (itx, setState) => itx.processor.onStateChange(setState),
    [],
  );
  const created = lifecycle.state?.created ?? false;

  // The welcome handoff: arrived here from the create form, so once the saga
  // commits `project/created` (a push flips `created` live — possibly before
  // first paint on a fast deployment), continue into the onboarding agent.
  useEffect(() => {
    if (welcome !== true || !created) return;
    void navigate({
      to: "/projects/$projectSlug/agents/streams/$",
      params: { projectSlug: params.projectSlug, _splat: "/agents/onboarding" },
      replace: true,
    });
  }, [welcome, created, navigate, params.projectSlug]);

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6">
        {created && welcome === true ? (
          // Handoff in flight (the effect above is navigating): keep showing
          // the finished checklist rather than flashing the settings page.
          <ProjectCreationProgress state={lifecycle.state} />
        ) : created ? (
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

        <ProjectEventStreamSection projectId={project.id} />
      </div>
    </section>
  );
}

/**
 * The raw event stream, positioned as the secondary view: collapsed by
 * default, and only mounted (it hosts a browser-side SQLite mirror) once
 * opened.
 */
function ProjectEventStreamSection({ projectId }: { projectId: string }) {
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
            projectId={projectId}
            streamPath={StreamPath.parse("/")}
          />
        </div>
      ) : null}
    </section>
  );
}
