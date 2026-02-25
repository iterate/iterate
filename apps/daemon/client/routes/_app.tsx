import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar.tsx";
import { AppSidebar } from "@/components/app-sidebar.tsx";
import { AppHeader } from "@/components/app-header.tsx";
import { orpc } from "@/integrations/tanstack-query/orpc-client.tsx";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

function AppLayout() {
  const params = useParams({ strict: false });
  const encodedAgentPath = "slug" in params ? (params.slug as string) : undefined;
  const agentPath = encodedAgentPath ? decodeURIComponent(encodedAgentPath) : undefined;

  const { data: agents = [] } = useQuery(orpc.daemon.listAgents.queryOptions());

  const currentAgent = agents.find((a) => a.path === agentPath);

  return (
    <SidebarProvider defaultOpen={true}>
      <div className="flex min-h-screen w-full">
        <AppSidebar agents={agents} />
        <SidebarInset>
          <AppHeader agent={currentAgent} agents={agents} />
          <main className="relative flex min-h-0 flex-1 flex-col overflow-auto">
            <Outlet />
          </main>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
