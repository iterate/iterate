import type { CSSProperties } from "react";
import { Outlet, createFileRoute } from "@tanstack/react-router";
import { Separator } from "@iterate-com/ui/components/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { AppSidebar } from "~/components/app-sidebar.tsx";
import { PathBreadcrumbs } from "~/components/path-breadcrumbs.tsx";
import { validateAppSearch } from "~/lib/project-slug.ts";
import { StreamsChromeProvider, StreamsHeaderAction } from "~/components/streams-chrome.tsx";

export const Route = createFileRoute("/_app")({
  validateSearch: validateAppSearch,
  component: AppLayout,
});

function AppLayout() {
  return (
    <SidebarProvider
      defaultOpen={true}
      className="h-svh"
      style={{ "--sidebar-width": "24rem" } as CSSProperties}
    >
      <StreamsChromeProvider>
        <AppSidebar />
        <SidebarInset className="min-w-0 overflow-hidden">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-1 h-4" />
            <PathBreadcrumbs />
            <div className="ml-auto">
              <StreamsHeaderAction />
            </div>
          </header>
          <main className="flex min-h-0 flex-1 flex-col overflow-auto">
            <Outlet />
          </main>
        </SidebarInset>
      </StreamsChromeProvider>
    </SidebarProvider>
  );
}
