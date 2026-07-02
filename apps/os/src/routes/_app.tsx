import { Outlet, createFileRoute, useMatches } from "@tanstack/react-router";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { requireOrganizationMemberForSession } from "../lib/auth.ts";
import { AppSidebar } from "~/components/app-sidebar.tsx";
import { GlobalCommandPalette } from "~/components/global-command-palette.tsx";
import { PathBreadcrumbs } from "~/components/path-breadcrumbs.tsx";
import { getPublicRouteConfig } from "~/lib/public-route-config.ts";
import type { AppRouteStaticData } from "~/lib/route-breadcrumbs.ts";
import { getSidebarDefaultOpen } from "~/lib/sidebar-state.ts";

export const Route = createFileRoute("/_app")({
  beforeLoad: ({ context, location }) =>
    requireOrganizationMemberForSession(context.authSession, location, context.iterateAuthIssuer),
  // The project list is NOT pre-warmed here: it comes from the itx session
  // (browser-only), so the sidebar populates it after hydration.
  loader: async () => ({
    routeConfig: await getPublicRouteConfig(),
    sidebarDefaultOpen: (await getSidebarDefaultOpen()).defaultOpen,
  }),
  component: AppLayout,
});

function AppLayout() {
  const { routeConfig, sidebarDefaultOpen } = Route.useLoaderData();
  const matches = useMatches();
  // Stream pages replace breadcrumbs with the ⌘K path pill and render their
  // own SidebarTrigger, so the shell header would just duplicate chrome.
  const hideAppHeader = matches.some(
    (match) => (match.staticData as AppRouteStaticData | undefined)?.hideAppHeader,
  );

  return (
    <SidebarProvider defaultOpen={sidebarDefaultOpen} className="h-svh">
      <AppSidebar routeConfig={routeConfig} />
      <SidebarInset className="min-w-0 overflow-hidden">
        {hideAppHeader ? null : (
          <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
            <div className="flex items-center gap-2 px-4">
              <SidebarTrigger className="-ml-1 md:hidden" />
              <PathBreadcrumbs />
            </div>
          </header>
        )}
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          <Outlet />
        </div>
      </SidebarInset>
      <GlobalCommandPalette />
    </SidebarProvider>
  );
}
