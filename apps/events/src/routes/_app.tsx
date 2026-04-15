import type { CSSProperties } from "react";
import { Outlet, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { Separator } from "@iterate-com/ui/components/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { AppSidebar } from "~/components/app-sidebar.tsx";
import { PathBreadcrumbs } from "~/components/path-breadcrumbs.tsx";
import { StreamsChromeProvider, StreamsHeaderAction } from "~/components/streams-chrome.tsx";

// First-party refs:
// - shadcn sidebar: https://ui.shadcn.com/docs/components/sidebar
// - TanStack Start server functions: https://tanstack.com/start/latest/docs/framework/react/guide/server-functions
const getSidebarDefaultOpen = createServerFn({ method: "GET" }).handler(() => ({
  defaultOpen: !/(?:^|;\s*)sidebar_state=false(?:;|$)/.test(getRequestHeader("cookie") ?? ""),
}));

export const Route = createFileRoute("/_app")({
  loader: async () => ({ sidebarDefaultOpen: (await getSidebarDefaultOpen()).defaultOpen }),
  component: AppLayout,
});

function AppLayout() {
  const { sidebarDefaultOpen } = Route.useLoaderData();

  return (
    <SidebarProvider
      defaultOpen={sidebarDefaultOpen}
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
