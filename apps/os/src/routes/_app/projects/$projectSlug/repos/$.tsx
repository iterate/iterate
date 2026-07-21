import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { useLiveState } from "iterate/sdk/itx/react";
import { InfoRow } from "~/components/info-row.tsx";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import { RepoIde } from "~/components/repo-ide/repo-ide.lazy.tsx";
import {
  breadcrumbLoaderData,
  streamBreadcrumb,
  streamPageStaticData,
} from "~/lib/route-breadcrumbs.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";

/** The stream-view params plus the IDE's own view state (open file, diff,
 * markdown/html preview, source-control/GitHub sidebar, history sidebar +
 * expanded commit). */
const RepoDetailSearch = StreamViewSearch.extend({
  file: z.string().optional().catch(undefined),
  diff: z.boolean().optional().catch(undefined),
  preview: z.boolean().optional().catch(undefined),
  scm: z.boolean().optional().catch(undefined),
  gh: z.boolean().optional().catch(undefined),
  staged: z.boolean().optional().catch(undefined),
  history: z.boolean().optional().catch(undefined),
  commit: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/_app/projects/$projectSlug/repos/$")({
  staticData: streamPageStaticData(),
  validateSearch: RepoDetailSearch,
  ssr: false,
  loader: ({ context, params }) =>
    breadcrumbLoaderData({
      project: context.project,
      streamBreadcrumb: streamBreadcrumb(context.project, repoPathFromSplat(params._splat)),
    }),
  component: ProjectRepoDetailContent,
});

function ProjectRepoDetailContent() {
  const params = Route.useParams();
  const { project } = Route.useLoaderData();
  const repoPath = repoPathFromSplat(params._splat);
  const repoProcessor = useLiveState(
    (itx) => itx.repos.get(repoPath).liveState,
    (state) => state,
    [repoPath],
  );

  // The IDE only mounts on an initialized repo (its file reads would throw
  // before the artifact exists); until then the panel shows the bootstrap
  // progress the processor state pushes in live.
  const state = repoProcessor.value;
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
      // data-spinner: this panel is live bootstrap progress (the processor
      // pushes each step in), and right after repo creation it can also show a
      // momentarily-stale checkpoint on a repo that IS already initialized —
      // waits must keep extending until the live push replaces it.
      <div className="overflow-y-auto p-4" data-spinner="true">
        <div className="mx-auto w-full max-w-2xl rounded-lg border bg-card">
          <InfoRow label="Created" value={state.birthCertificate !== null ? "yes" : "not yet"} />
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
