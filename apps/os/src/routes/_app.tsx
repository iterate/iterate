import { Outlet, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { Separator } from "@iterate-com/ui/components/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { requireActiveOrganizationForRoute } from "../lib/auth.ts";
import { AppSidebar } from "~/components/app-sidebar.tsx";
import { PathBreadcrumbs } from "~/components/path-breadcrumbs.tsx";
import { projectsListQueryOptions } from "~/lib/project-route-query.ts";
import { getPublicRouteConfig } from "~/lib/public-route-config.ts";

const getSidebarDefaultOpen = createServerFn({ method: "GET" }).handler(() => ({
  defaultOpen: !/(?:^|;\s*)sidebar_state=false(?:;|$)/.test(getRequestHeader("cookie") ?? ""),
}));

export const Route = createFileRoute("/_app")({
  beforeLoad: () => requireActiveOrganizationForRoute(),
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(projectsListQueryOptions({ limit: 100, offset: 0 }));

    return {
      routeConfig: await getPublicRouteConfig(),
      sidebarDefaultOpen: (await getSidebarDefaultOpen()).defaultOpen,
    };
  },
  component: AppLayout,
});

function AppLayout() {
  const { routeConfig, sidebarDefaultOpen } = Route.useLoaderData();

  return (
    <SidebarProvider defaultOpen={sidebarDefaultOpen} className="h-svh">
      <AppSidebar routeConfig={routeConfig} />
      <SidebarInset className="min-w-0 overflow-hidden">
        <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
          <div className="flex items-center gap-2 px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 data-vertical:h-4" />
            <PathBreadcrumbs />
          </div>
        </header>
        <main className="flex min-h-0 flex-1 flex-col overflow-auto">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
