import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";

import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar.tsx";
import { AppSidebar } from "@/components/app-sidebar.tsx";
import { AppHeader } from "@/components/app-header.tsx";
import { RawModeProvider } from "@/hooks/raw-mode-provider.tsx";
import { useAgents } from "@/hooks/use-agents.ts";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

function AppLayout() {
  const params = useParams({ strict: false });
  const agentId = "agentId" in params ? (params.agentId as string) : undefined;

  const { data: agents = [] } = useAgents();

  const agentInfos = agents.map((a) => ({
    path: a.slug,
    contentType: "application/json",
    createdAt: a.createdAt instanceof Date ? a.createdAt.toISOString() : String(a.createdAt),
  }));

  return (
    <RawModeProvider>
      <SidebarProvider defaultOpen={false}>
        <AppSidebar agents={agentInfos} />
        <SidebarInset className="max-h-svh">
          <AppHeader agentId={agentId} />
          <div className="flex-1 min-h-0">
            <Outlet />
          </div>
        </SidebarInset>
      </SidebarProvider>
    </RawModeProvider>
  );
}
