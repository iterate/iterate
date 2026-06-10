import { useMemo } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import type { StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import { StreamTreeBrowser } from "~/components/stream-tree-browser.tsx";
import { useAdminItx } from "~/lib/admin-itx.ts";
import { StreamNavigationState } from "~/lib/stream-navigation-state.ts";
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
    () => ({
      key: ["admin", "streams", namespace] as const,
      getState: async (path: StreamPathType) =>
        StreamNavigationState.parse(await itx.streams.namespace(namespace).get(path).getState()),
    }),
    [itx, namespace],
  );

  function openStream(path: StreamPathType) {
    void navigate({
      to: "/admin/streams/$namespace/$",
      params: { namespace, _splat: path },
    });
  }

  return (
    <section className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[20rem_minmax(0,1fr)]">
      <aside className="hidden min-h-0 border-r p-3 lg:flex">
        <StreamTreeBrowser source={source} currentPath={streamPath} onOpenPath={openStream} />
      </aside>
      <ProjectStreamView
        emptyLabel="No events in this stream yet."
        projectSlug={namespace}
        projectSlugOrId={namespace}
        renderStreamPathLink={({ path, children, className }) => (
          <Link
            to="/admin/streams/$namespace/$"
            params={{ namespace, _splat: path }}
            {...(className == null ? {} : { className })}
          >
            {children}
          </Link>
        )}
        streamPath={streamPath}
        streamUrl={adminStreamRpcPath(namespace, streamPath)}
      />
    </section>
  );
}
