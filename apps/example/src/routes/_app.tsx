import { Outlet, createFileRoute } from "@tanstack/react-router";
import { Separator } from "@iterate-com/ui/components/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { AppSidebar } from "../components/app-sidebar.tsx";
import { PathBreadcrumbs } from "../components/path-breadcrumbs.tsx";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

function AppLayout() {
  return (
    <SidebarProvider defaultOpen={true}>
      <AppSidebar />
      <SidebarInset className="min-w-0 overflow-hidden">
        <div className="border-b bg-gradient-to-r from-amber-300 via-orange-300 to-rose-300 px-4 py-8">
          <div className="mx-auto w-full max-w-5xl">
            <p className="text-4xl font-black tracking-tight text-slate-950 sm:text-6xl">
              hi misha
            </p>
          </div>
        </div>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 h-4" />
          <PathBreadcrumbs />
        </header>
        <main className="flex min-h-0 flex-1 flex-col overflow-auto">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
