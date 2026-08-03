import { Outlet, createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { RemoteStreamTable } from "~/components/streams/remote-stream-table.tsx";
import { streamPathFromSplatOrRoot } from "~/lib/stream-links.ts";
import { streamProjectDisplayLabel, useAdminStreamSource } from "~/lib/stream-navigation.ts";

export const Route = createFileRoute("/admin/streams/$projectId")({
  component: AdminStreamProjectLayout,
});

function AdminStreamProjectLayout() {
  const { projectId } = Route.useParams();
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const splat = typeof params._splat === "string" ? params._splat : undefined;
  const currentPath = streamPathFromSplatOrRoot(splat);
  const { source } = useAdminStreamSource(projectId);
  const openStreamPath = (path: string) => {
    if (path === "/") {
      void navigate({
        to: "/admin/streams/$projectId",
        params: { projectId },
        search: {},
      });
      return;
    }

    void navigate({
      to: "/admin/streams/$projectId/$",
      params: { projectId, _splat: path },
      search: {},
    });
  };

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
          <RemoteStreamTable
            key={projectId}
            currentPath={currentPath}
            scope={projectId}
            source={source}
            onOpenPath={openStreamPath}
          />
        </div>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}
