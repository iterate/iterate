import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { useItx } from "iterate/sdk/itx/react";
import type { WorkspaceSurface, WorkspaceTransport } from "@iterate-com/workspace-documents/types";
import { WorkspaceChanges } from "@iterate-com/workspace-documents/workspace-changes";
import { WorkspaceFileView } from "@iterate-com/workspace-documents/workspace-file-view";
import { useWorkspaceFiles } from "@iterate-com/workspace-documents/workspace-files";
import { WorkspaceTree } from "@iterate-com/workspace-documents/workspace-tree";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import {
  breadcrumbLoaderData,
  streamBreadcrumb,
  streamPageStaticData,
} from "~/lib/route-breadcrumbs.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";

/** The stream-view params plus the open file. */
const WorkspaceDetailSearch = StreamViewSearch.extend({
  file: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/_app/projects/$projectSlug/workspaces/$")({
  staticData: streamPageStaticData(),
  validateSearch: WorkspaceDetailSearch,
  ssr: false,
  loader: ({ context, params }) =>
    breadcrumbLoaderData({
      project: context.project,
      streamBreadcrumb: streamBreadcrumb(context.project, workspacePathFromSplat(params._splat)),
    }),
  // The loader depends on the project and workspace path, never the open
  // file: keep file switches synchronous.
  shouldReload: false,
  component: ProjectWorkspaceDetailContent,
});

/**
 * One workspace inside OS: the same tree, file view, and per-mount commit
 * controls the Docs app renders, handed the live itx stub — no vessel, no
 * app-side state. An agent's workspace opens here from its details sheet.
 */
function ProjectWorkspaceDetailContent() {
  const params = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { project } = Route.useLoaderData();
  const workspacePath = workspacePathFromSplat(params._splat);
  const itx = useItx();
  const transport = useMemo<WorkspaceTransport>(() => {
    // The itx stub IS the workspace surface (capnweb maps every method to a
    // promise); the cast only narrows the generated pipelining types.
    const run = <T,>(operation: (workspace: WorkspaceSurface) => PromiseLike<T>) =>
      Promise.resolve(operation(itx.workspaces.get(workspacePath) as unknown as WorkspaceSurface));
    return { run, runOnce: run };
  }, [itx, workspacePath]);
  const files = useWorkspaceFiles({ transport, workspacePath, listAtOnce: ["/repos/config"] });
  const selectedPath = search.file;
  const onSelect = useCallback(
    (path: string | null) =>
      void navigate({ search: (current) => ({ ...current, file: path ?? undefined }) }),
    [navigate],
  );
  const { ensureLoaded } = files;
  useEffect(() => {
    if (selectedPath !== undefined) ensureLoaded(selectedPath);
  }, [ensureLoaded, selectedPath]);
  // A discard replaced the open file under its view: remount it.
  const [revision, setRevision] = useState(0);
  const onDocumentRevised = useCallback(() => setRevision((current) => current + 1), []);

  const actions = (
    <WorkspaceChanges
      files={files}
      canCommit
      onDiscarded={(scope) => {
        if (selectedPath === undefined) return;
        const underScope =
          scope === null
            ? selectedPath.startsWith(`${workspacePath}/`)
            : selectedPath.startsWith(`${scope}/`);
        if (!underScope) return;
        if (files.changes.get(selectedPath) === "added") onSelect(null);
        else onDocumentRevised();
      }}
    />
  );
  const panel = (
    <div className="flex min-h-0 flex-1">
      <WorkspaceTree
        key={workspacePath}
        files={files}
        workspacePath={workspacePath}
        selectedPath={selectedPath}
        onSelect={onSelect}
        onDocumentRevised={onDocumentRevised}
        className="w-72 shrink-0 border-r bg-background"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {selectedPath === undefined ? (
          <>
            <header className="flex h-14 shrink-0 items-center justify-end gap-2 border-b px-3">
              {actions}
            </header>
            <div className="grid min-h-0 flex-1 place-items-center text-sm text-muted-foreground">
              Pick a file.
            </div>
          </>
        ) : (
          <WorkspaceFileView
            key={`${selectedPath}:${revision}`}
            transport={transport}
            path={selectedPath}
            actions={actions}
          />
        )}
      </div>
    </div>
  );

  return (
    <ProjectStreamView
      layout="fullPanel"
      panel={panel}
      projectId={project.id}
      streamPath={workspacePath}
      emptyLabel="No events on this workspace's stream yet."
    />
  );
}

function workspacePathFromSplat(splat: string | undefined) {
  const suffix = splat?.replace(/^\/+/, "") ?? "";
  return `/workspaces/${suffix}`;
}
