import { useMemo } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { StreamExplorerDetail } from "~/components/stream-explorer.tsx";
import { NULL_DURABLE_OBJECT_PROJECT_ID } from "~/domains/durable-object-names.ts";
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

  function openStream(path: string) {
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
        streamSource: source,
      }}
    />
  );
}
