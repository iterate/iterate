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
      <div className="flex min-h-screen w-full">
        <AppSidebar deployments={deployments} selectedSlug={selectedSlug} />
        <SidebarInset>
          <main className="flex-1 p-4">
            <Outlet />
          </main>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
