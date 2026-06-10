import { useMemo } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import type { StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";
import { StreamExplorerDetail } from "~/components/stream-explorer.tsx";
import { useAdminItx } from "~/lib/admin-itx.ts";
import { adminStreamRpcPath } from "~/lib/stream-rpc-paths.ts";
import { streamPathFromSplat, streamPathToSplat } from "~/lib/stream-links.ts";

export const Route = createFileRoute("/admin/streams/$namespace/$")({
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
  const { namespace, _splat: streamPath } = Route.useParams();
  const itx = useAdminItx();
  const navigate = useNavigate();
  const source = useMemo(
    () => (path: StreamPathType) => itx.streams.namespace(namespace).get(path),
    [itx, namespace],
  );

  function openStream(path: StreamPathType) {
    void navigate({
      to: "/admin/streams/$namespace/$",
      params: { namespace, _splat: path },
    });
  }

  return (
    <StreamExplorerDetail
      currentPath={streamPath}
      onOpenPath={openStream}
      source={source}
      streamView={{
        emptyLabel: "No events in this stream yet.",
        projectSlug: namespace,
        projectSlugOrId: namespace,
        renderStreamPathLink: ({ path, children, className }) => (
          <Link
            to="/admin/streams/$namespace/$"
            params={{ namespace, _splat: path }}
            {...(className == null ? {} : { className })}
          >
            {children}
          </Link>
        ),
        streamUrl: adminStreamRpcPath(namespace, streamPath),
      }}
    />
  );
}
