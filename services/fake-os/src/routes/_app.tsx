import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { SidebarProvider, SidebarInset } from "@iterate-com/ui/components/sidebar";
import { AppSidebar } from "@/components/app-sidebar.tsx";
import { orpc } from "@/lib/orpc.ts";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

function AppLayout() {
  const params = useParams({ strict: false });
  const selectedSlug = "slug" in params ? (params.slug as string) : undefined;

  const { data: deployments = [] } = useQuery(orpc.deployments.list.queryOptions());

  return (
    <SidebarProvider defaultOpen={true}>
      <div className="flex h-screen w-full overflow-hidden">
        <AppSidebar deployments={deployments} selectedSlug={selectedSlug} />
        <SidebarInset className="flex min-w-0 flex-col overflow-hidden">
          <main className="min-h-0 flex-1 overflow-auto p-4">
            <Outlet />
          </main>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
