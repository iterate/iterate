import { useMemo } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, RadioTowerIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import type { StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";
import { StreamExplorerTreePage } from "~/components/stream-explorer.tsx";
import { useItx } from "~/itx/itx-react.tsx";

export const Route = createFileRoute("/admin/streams/$projectId/")({
  component: AdminStreamProjectPage,
});

function AdminStreamProjectPage() {
  const { projectId } = Route.useParams();
  const itx = useItx();
  const navigate = useNavigate();
  const streamProjectId = projectId === "global" ? null : projectId;
  const source = useMemo(
    () => (streamPath: StreamPathType) => itx.streams.project(streamProjectId).get(streamPath),
    [itx, streamProjectId],
  );

  function openStream(streamPath: StreamPathType) {
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
            {projectId === "global" ? null : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                nativeButton={false}
                render={<Link to="/admin/streams/$projectId" params={{ projectId: "global" }} />}
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
