import { Outlet, createFileRoute } from "@tanstack/react-router";
import { Separator } from "@iterate-com/ui/components/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { AppSidebar } from "../components/app-sidebar.tsx";
import { HeaderActionsProvider } from "../components/header-actions.tsx";
import { PathBreadcrumbs } from "../components/path-breadcrumbs.tsx";
import { useHeaderActions } from "../hooks/use-header-actions.ts";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

function AppLayout() {
  const [headerActions, setHeaderActions] = useHeaderActions();

  return (
    <SidebarProvider defaultOpen={false}>
      <AppSidebar />
      <SidebarInset className="min-w-0 overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 h-4" />
          <div className="min-w-0 flex-1">
            <PathBreadcrumbs />
          </div>
          {headerActions}
        </header>
        <main className="flex min-h-0 flex-1 flex-col overflow-auto">
          <HeaderActionsProvider onActionsChange={setHeaderActions}>
            <Outlet />
          </HeaderActionsProvider>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
