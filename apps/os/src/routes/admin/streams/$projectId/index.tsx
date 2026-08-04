import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeftIcon, RadioTowerIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
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

// The project's root stream. The layout owns persistent stream navigation;
// this panel carries project/global switching and stream-view controls.
function AdminStreamProjectPage() {
  const { projectId } = Route.useParams();
  const { source, streamProjectId, resetTransport } = useAdminStreamSource(projectId);

  const panel = (
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
  );

  return (
    <ProjectStreamView
      panel={panel}
      projectId={streamProjectId}
      streamSource={source}
      resetStreamSourceTransport={resetTransport}
      streamPath="/"
      emptyLabel="No events in the root stream yet."
    />
  );
}
