import { useMemo } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, RadioTowerIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { StreamExplorerTreePage } from "~/components/stream-explorer.tsx";
import { NULL_DURABLE_OBJECT_PROJECT_ID } from "~/lib/stream-navigation.ts";
import { useItx } from "~/itx/itx-react.tsx";

export const Route = createFileRoute("/admin/streams/$projectId/")({
  component: AdminStreamProjectPage,
});

function AdminStreamProjectPage() {
  const { projectId } = Route.useParams();
  const itx = useItx();
  const navigate = useNavigate();
  const streamProjectId = projectId === NULL_DURABLE_OBJECT_PROJECT_ID ? null : projectId;
  // Admin pages address arbitrary projects through the global (admin) session:
  // the deployment-wide stream catalog for the null project, otherwise the
  // project's own itx via projects.get(id).
  const source = useMemo(
    () => (streamPath: string) =>
      streamProjectId == null
        ? itx.streams.get(streamPath)
        : itx.projects.get(streamProjectId).streams.get(streamPath),
    [itx, streamProjectId],
  );

  function openStream(streamPath: string) {
    void navigate({
      to: "/admin/streams/$projectId/$",
      params: { projectId, _splat: streamPath },
    });
  }

  return (
    <StreamExplorerTreePage
      header={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold">Streams explorer</h1>
            <p className="truncate font-mono text-sm text-muted-foreground">{projectId}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<Link to="/admin/streams" />}
            >
              <ArrowLeftIcon data-icon="inline-start" aria-hidden="true" />
              Project
            </Button>
            {projectId === NULL_DURABLE_OBJECT_PROJECT_ID ? null : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                nativeButton={false}
                render={
                  <Link
                    to="/admin/streams/$projectId"
                    params={{ projectId: NULL_DURABLE_OBJECT_PROJECT_ID }}
                  />
                }
              >
                <RadioTowerIcon data-icon="inline-start" aria-hidden="true" />
                Global
              </Button>
            )}
          </div>
        </div>
      }
      source={source}
      onOpenPath={openStream}
    />
  );
}
