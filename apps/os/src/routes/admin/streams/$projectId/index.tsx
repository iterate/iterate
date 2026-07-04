import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, RadioTowerIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import { StreamTreeBrowser } from "~/components/stream-tree-browser.tsx";
import {
  NULL_DURABLE_OBJECT_PROJECT_ID,
  streamProjectDisplayLabel,
  useAdminStreamSource,
} from "~/lib/stream-navigation.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";

export const Route = createFileRoute("/admin/streams/$projectId/")({
  validateSearch: StreamViewSearch,
  ssr: false,
  component: AdminStreamProjectPage,
});

function AdminStreamProjectPage() {
  const { projectId } = Route.useParams();
  const navigate = useNavigate();
  const { source, streamProjectId } = useAdminStreamSource(projectId);

  function openStream(streamPath: string) {
    void navigate({
      to: "/admin/streams/$projectId/$",
      params: { projectId, _splat: streamPath },
      // Fresh view state on the opened stream.
      search: {},
    });
  }

  const panel = (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">Streams explorer</h1>
          <p className="truncate font-mono text-sm text-muted-foreground">
            {streamProjectDisplayLabel(projectId)}
          </p>
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
      <StreamTreeBrowser source={source} onOpenPath={openStream} />
    </>
  );

  return (
    <ProjectStreamView
      panel={panel}
      showCommandPaletteTrigger={false}
      projectId={streamProjectId}
      streamSource={source}
      streamPath="/"
      emptyLabel="No events in the root stream yet."
    />
  );
}
