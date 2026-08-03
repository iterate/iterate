import { Outlet, createFileRoute, useMatch, useNavigate } from "@tanstack/react-router";
import { useLiveState } from "iterate/sdk/itx/react";
import { StreamIndexTablePanel } from "~/components/streams/stream-index-table.tsx";
import { streamPathFromSplatOrRoot } from "~/lib/stream-links.ts";
import { linkOptionsForAdminStreamPath } from "~/lib/stream-routes.ts";
import {
  NULL_DURABLE_OBJECT_PROJECT_ID,
  streamProjectDisplayLabel,
} from "~/lib/stream-navigation.ts";

export const Route = createFileRoute("/admin/streams/$projectId")({
  component: AdminStreamProjectLayout,
});

function AdminStreamProjectLayout() {
  const { projectId } = Route.useParams();
  const navigate = useNavigate();
  const splat = useMatch({
    from: "/admin/streams/$projectId/$",
    shouldThrow: false,
    select: (match) => match.params._splat,
  });
  const currentPath = streamPathFromSplatOrRoot(splat);
  const streamIndexAvailable = projectId !== NULL_DURABLE_OBJECT_PROJECT_ID;
  const streamsState = useLiveState(
    (itx) => itx.liveState,
    (state) => state.streamsIndex,
    [projectId],
    { slug: projectId, enabled: streamIndexAvailable },
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
      <aside className="flex max-h-72 min-h-0 shrink-0 flex-col border-b lg:max-h-none lg:w-80 lg:border-r lg:border-b-0">
        <div className="shrink-0 border-b px-3 py-2">
          <p className="text-xs font-medium">Streams</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {streamProjectDisplayLabel(projectId)}
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <StreamIndexTablePanel
            key={projectId}
            available={streamIndexAvailable}
            currentPath={currentPath}
            error={streamsState.status === "error"}
            streams={streamsState.value}
            onOpenPath={(path) => {
              void navigate(linkOptionsForAdminStreamPath(projectId, path));
            }}
          />
        </div>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}
