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
  const activeOrganization = Route.useRouteContext();
  const { routeConfig, sidebarDefaultOpen } = Route.useLoaderData();

  return (
    <SidebarProvider defaultOpen={sidebarDefaultOpen} className="h-svh">
      <AppSidebar organizationSlug={activeOrganization.orgSlug} routeConfig={routeConfig} />
      <SidebarInset className="min-w-0 overflow-hidden">
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
