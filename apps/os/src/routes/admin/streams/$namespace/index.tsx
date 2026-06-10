import { useMemo } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, RadioTowerIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { StreamState, type StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";
import { StreamExplorerTreePage } from "~/components/stream-explorer.tsx";
import { useAdminItx } from "~/lib/admin-itx.ts";

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
        StreamState.parse(await itx.streams.namespace(namespace).get(streamPath).getState()),
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
    <StreamExplorerTreePage
      header={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold">Streams explorer</h1>
            <p className="truncate font-mono text-sm text-muted-foreground">{namespace}</p>
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
              Namespace
            </Button>
            {namespace === "global" ? null : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                nativeButton={false}
                render={<Link to="/admin/streams/$namespace" params={{ namespace: "global" }} />}
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
