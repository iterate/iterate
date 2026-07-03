import { useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { StreamPage } from "~/components/stream-page.tsx";
import { NULL_DURABLE_OBJECT_PROJECT_ID } from "~/lib/stream-navigation.ts";
import { useItx } from "~/itx/itx-react.tsx";
import { streamPathFromSplat, streamPathToSplat } from "~/lib/stream-links.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";

export const Route = createFileRoute("/admin/streams/$projectId/$")({
  params: {
    parse: (raw) => ({
      _splat: streamPathFromSplat(raw._splat),
    }),
    stringify: (parsed) => ({
      _splat: streamPathToSplat(parsed._splat),
    }),
  },
  validateSearch: StreamViewSearch,
  ssr: false,
  component: AdminStreamDetailPage,
});

function AdminStreamDetailPage() {
  const { projectId, _splat: streamPath } = Route.useParams();
  const itx = useItx();
  const streamProjectId = projectId === NULL_DURABLE_OBJECT_PROJECT_ID ? null : projectId;
  // Admin pages address arbitrary projects through the global (admin) session:
  // the deployment-wide stream catalog for the null project, otherwise the
  // project's own itx via projects.get(id).
  const source = useMemo(
    () => (path: string) =>
      streamProjectId == null
        ? itx.streams.get(path)
        : itx.projects.get(streamProjectId).streams.get(path),
    [itx, streamProjectId],
  );

  return (
    <StreamPage
      emptyLabel="No events in this stream yet."
      projectId={streamProjectId}
      streamSource={source}
      streamPath={streamPath}
    />
  );
}
