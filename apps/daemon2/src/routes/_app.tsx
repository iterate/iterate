import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar.tsx";
import { AppSidebar } from "@/components/app-sidebar.tsx";
import { AppHeader } from "@/components/app-header.tsx";
import { useTRPC } from "@/integrations/trpc/react.ts";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

function AppLayout() {
  const params = useParams({ strict: false });
  const tmuxSessionName =
    "tmuxSessionName" in params ? (params.tmuxSessionName as string) : undefined;

  const trpc = useTRPC();
  const { data: tmuxSessions = [] } = useQuery({
    ...trpc.listTmuxSessions.queryOptions(),
    refetchInterval: 1000, // Poll every second
  });

  return (
    <SidebarProvider defaultOpen={false}>
      <AppSidebar tmuxSessions={tmuxSessions} />
      <SidebarInset className="max-h-svh">
        <AppHeader tmuxSessionName={tmuxSessionName} />
        <div className="flex-1 min-h-0">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
