import { Outlet, createFileRoute, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Separator } from "@iterate-com/ui/components/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { AppSidebar } from "~/components/app-sidebar.tsx";
import { PathBreadcrumbs } from "~/components/path-breadcrumbs.tsx";
import { orpc } from "~/orpc/client.ts";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

function AppLayout() {
  const params = useParams({ strict: false });
  const selectedSlug = "slug" in params ? (params.slug as string) : undefined;

  const { data: deployments = [] } = useQuery(orpc.deployments.list.queryOptions());

  return (
    <SidebarProvider defaultOpen={true}>
      <AppSidebar deployments={deployments} selectedSlug={selectedSlug} />
      <SidebarInset className="min-w-0 overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 h-4" />
          <PathBreadcrumbs />
        </header>
        <main className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
