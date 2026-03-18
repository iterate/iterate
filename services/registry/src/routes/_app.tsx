import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SidebarProvider, SidebarInset } from "@iterate-com/ui/components/sidebar";
import { AppSidebar } from "@/components/app-sidebar.tsx";

export const Route = createFileRoute("/_app")({
  ssr: false,
  component: AppLayout,
});

function AppLayout() {
  return (
    <SidebarProvider defaultOpen={true}>
      <div className="flex h-screen w-full overflow-hidden">
        <AppSidebar />
        <SidebarInset className="flex min-w-0 flex-col overflow-hidden">
          <main className="min-h-0 flex-1 overflow-auto p-4">
            <Outlet />
          </main>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
