import { useMemo } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";
import { StreamTreeBrowser } from "~/components/stream-tree-browser.tsx";
import { useAdminItx } from "~/lib/admin-itx.ts";
import { parseStreamNavigationState } from "~/lib/stream-navigation-state.ts";

export const Route = createFileRoute("/admin/streams/$namespace/")({
  component: AdminStreamNamespacePage,
});

function AdminStreamNamespacePage() {
  const { namespace } = Route.useParams();
  const itx = useAdminItx();
  const navigate = useNavigate();
  const source = useMemo(
    () => ({
      key: ["admin", "streams", namespace] as const,
      getState: async (streamPath: StreamPathType) =>
        parseStreamNavigationState(
          await itx.streams.namespace(namespace).get(streamPath).getState(),
        ),
    }),
    [itx, namespace],
  );

  function openStream(streamPath: StreamPathType) {
    void navigate({
      to: "/admin/streams/$namespace/$",
      params: { namespace, _splat: streamPath },
    });
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <div className="min-w-0">
        <h1 className="truncate text-lg font-semibold">
          Namespace{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">{namespace}</code>
        </h1>
      </div>
      <StreamTreeBrowser source={source} onOpenPath={openStream} />
    </section>
  );
}
