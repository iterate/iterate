import { createFileRoute } from "@tanstack/react-router";
import { StreamPage } from "~/components/stream-page.tsx";
import { useAdminStreamSource } from "~/lib/stream-navigation.ts";
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
  const { source, streamProjectId } = useAdminStreamSource(projectId);

  return (
    <StreamPage
      emptyLabel="No events in this stream yet."
      projectId={streamProjectId}
      streamSource={source}
      streamPath={streamPath}
    />
  );
}
