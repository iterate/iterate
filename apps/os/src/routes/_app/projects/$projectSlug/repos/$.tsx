import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import type { RepoProcessorState } from "../../../../../domains/repos/repo-processor-contract.ts";
import { InfoRow } from "~/components/info-row.tsx";
import { ItxBoundary } from "~/components/itx-boundary.tsx";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import { RepoIde } from "~/components/repo-ide/repo-ide.lazy.tsx";
import { breadcrumbLoaderData, streamBreadcrumb } from "~/lib/route-breadcrumbs.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";
import { useItxState } from "~/itx/itx-react.tsx";

/** The stream-view params plus the IDE's own view state (open file, diff,
 * html preview, source-control sidebar). */
const RepoDetailSearch = StreamViewSearch.extend({
  file: z.string().optional().catch(undefined),
  diff: z.boolean().optional().catch(undefined),
  preview: z.boolean().optional().catch(undefined),
  scm: z.boolean().optional().catch(undefined),
  staged: z.boolean().optional().catch(undefined),
});

export const Route = createFileRoute("/_app/projects/$projectSlug/repos/$")({
  validateSearch: RepoDetailSearch,
  ssr: false,
  loader: ({ context, params }) =>
    breadcrumbLoaderData({
      project: context.project,
      streamBreadcrumb: streamBreadcrumb(context.project, repoPathFromSplat(params._splat)),
    }),
  component: ProjectRepoDetailPage,
});

function ProjectRepoDetailPage() {
  return (
    <ItxBoundary>
      <ProjectRepoDetailContent />
    </ItxBoundary>
  );
}

function ProjectRepoDetailContent() {
  const params = Route.useParams();
  const { project } = Route.useLoaderData();
  const repoPath = repoPathFromSplat(params._splat);
  const repoProcessor = useItxState<RepoProcessorState>(
    (itx, setState) => itx.repos.get(repoPath).processor.onStateChange(setState),
    [repoPath],
  );

  // The IDE only mounts on an initialized repo (its file reads would throw
  // before the artifact exists); until then the panel shows the bootstrap
  // progress the processor state pushes in live.
  const state = repoProcessor.state;
  const panel =
    state === undefined ? (
      <div
        className="grid flex-1 place-items-center text-sm text-muted-foreground"
        data-spinner="true"
      >
        Loading repo…
      </div>
    ) : state.initialized ? (
      <RepoIde key={`${project.id}:${repoPath}`} projectId={project.id} repoPath={repoPath} />
    ) : (
      <div className="overflow-y-auto p-4">
        <div className="mx-auto w-full max-w-2xl rounded-lg border bg-card">
          <InfoRow label="Created" value={state.created ? "yes" : "not yet"} />
          <InfoRow label="Initialized" value={state.initialized ? "yes" : "not yet"} />
          <InfoRow label="Default branch" value={state.defaultBranch ?? "(none)"} />
          <InfoRow
            label="Remote"
            value={state.remote ?? "(none)"}
            copyValue={state.remote ?? undefined}
          />
          <InfoRow label="Artifact" value={state.artifactName ?? "(none)"} />
        </div>
      </div>
    );

  return (
    <ProjectStreamView
      layout="fullPanel"
      panel={panel}
      projectId={project.id}
      streamPath={repoPath}
      emptyLabel="No events on this repo's stream yet."
    />
  );
}

function repoPathFromSplat(splat: string | undefined) {
  const suffix = splat?.replace(/^\/+/, "") ?? "";
  return `/repos/${suffix}`;
}
