import { useMemo } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import type { StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";
import { StreamExplorerDetail } from "~/components/stream-explorer.tsx";
import { useItx } from "~/itx/itx-react.tsx";
import { streamPathFromSplat, streamPathToSplat } from "~/lib/stream-links.ts";

export const Route = createFileRoute("/admin/streams/$projectId/$")({
  params: {
    parse: (raw) => ({
      _splat: streamPathFromSplat(raw._splat),
    }),
    stringify: (parsed) => ({
      _splat: streamPathToSplat(parsed._splat),
    }),
  },
  ssr: false,
  component: AdminStreamDetailPage,
});

function AdminStreamDetailPage() {
  const { projectId, _splat: streamPath } = Route.useParams();
  const itx = useItx();
  const navigate = useNavigate();
  const streamProjectId = projectId === "__global__" ? null : projectId;
  const source = useMemo(
    () => (path: StreamPathType) => itx.streams.project(streamProjectId).get(path),
    [itx, streamProjectId],
  );

  function openStream(path: StreamPathType) {
    void navigate({
      to: "/admin/streams/$projectId/$",
      params: { projectId, _splat: path },
    });
  }

  return (
    <StreamExplorerDetail
      currentPath={streamPath}
      onOpenPath={openStream}
      source={source}
      streamView={{
        emptyLabel: "No events in this stream yet.",
        projectSlug: projectId,
        projectId: streamProjectId,
        renderStreamPathLink: ({ path, children, className }) => (
          <Link
            to="/admin/streams/$projectId/$"
            params={{ projectId, _splat: path }}
            {...(className == null ? {} : { className })}
          >
            {children}
          </Link>
        ),
        streamSource: (path) => itx.streams.project(streamProjectId).get(path),
      }}
    />
  );
}
