import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar.tsx";
import { AppSidebar } from "@/components/app-sidebar.tsx";
import { AppHeader } from "@/components/app-header.tsx";
import { useTRPC } from "@/integrations/tanstack-query/trpc-client.tsx";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

function AppLayout() {
  const params = useParams({ strict: false });
  const agentSlug = "slug" in params ? (params.slug as string) : undefined;

  const trpc = useTRPC();
  const { data: agents = [] } = useQuery(trpc.listAgents.queryOptions());

  const currentAgent = agents.find((a) => a.slug === agentSlug);

  return (
    <SidebarProvider defaultOpen={true}>
      <AppSidebar agents={agents} />
      <SidebarInset className="max-h-svh">
        <AppHeader agent={currentAgent} />
        <div className="flex-1 min-h-0">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
