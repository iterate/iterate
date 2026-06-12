import { Outlet, createFileRoute, useMatches } from "@tanstack/react-router";
import { Separator } from "@iterate-com/ui/components/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { requireOrganizationMemberForSession } from "../lib/auth.ts";
import { AppSidebar } from "~/components/app-sidebar.tsx";
import { PathBreadcrumbs } from "~/components/path-breadcrumbs.tsx";
import { projectsListQueryOptions } from "~/lib/project-route-query.ts";
import { getPublicRouteConfig } from "~/lib/public-route-config.ts";
import type { RouteBreadcrumbStaticData } from "~/lib/route-breadcrumbs.ts";
import { getSidebarDefaultOpen } from "~/lib/sidebar-state.ts";

export const Route = createFileRoute("/_app")({
  beforeLoad: ({ context, location }) =>
    requireOrganizationMemberForSession(context.authSession, location, context.iterateAuthIssuer),
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
  const matches = useMatches();
  // Stream pages replace breadcrumbs with the ⌘K path pill and render their
  // own SidebarTrigger, so the shell header would just duplicate chrome.
  const hideAppHeader = matches.some(
    (match) => (match.staticData as RouteBreadcrumbStaticData | undefined)?.hideAppHeader,
  );

  return (
    <SidebarProvider defaultOpen={sidebarDefaultOpen} className="h-svh">
      <AppSidebar routeConfig={routeConfig} />
      <SidebarInset className="min-w-0 overflow-hidden">
        {hideAppHeader ? null : (
          <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
            <div className="flex items-center gap-2 px-4">
              <SidebarTrigger className="-ml-1" />
              <Separator
                orientation="vertical"
                className="mr-2 data-vertical:h-4 data-vertical:self-auto"
              />
              <PathBreadcrumbs />
            </div>
          </header>
        )}
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
