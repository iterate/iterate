import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useTRPC } from "../../lib/trpc.ts";
import { AppSidebar } from "../../components/app-sidebar.tsx";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "../../components/ui/sidebar.tsx";

export const Route = createFileRoute("/_auth.layout/$organizationSlug")({
  component: OrganizationLayout,
});

function OrganizationLayout() {
  const trpc = useTRPC();
  const { data: user } = useSuspenseQuery(trpc.user.me.queryOptions());

  return (
    <SidebarProvider defaultOpen={true}>
      <div className="flex min-h-screen w-full">
        <AppSidebar user={user} />
        <SidebarInset>
          <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger />
          </header>
          <main className="flex flex-1 flex-col gap-4 p-6 max-w-6xl">
            <Outlet />
          </main>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
