import { Outlet, createFileRoute } from "@tanstack/react-router";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { requireOrganizationMemberForSession } from "../lib/auth.ts";
import { AppSidebar } from "~/components/app-sidebar.tsx";
import { GlobalCommandPalette } from "~/components/global-command-palette.tsx";
import { openGlobalCommandPalette } from "~/components/global-command-palette-events.ts";
import { PathBreadcrumbs } from "~/components/path-breadcrumbs.tsx";
import { getPublicRouteConfig } from "~/lib/public-route-config.ts";
import { getSidebarDefaultOpen } from "~/lib/sidebar-state.ts";

export const Route = createFileRoute("/_app")({
  beforeLoad: ({ context, location }) =>
    requireOrganizationMemberForSession(
      context.authSession,
      location,
      context.iterateAuthIssuer,
      context.authError,
    ),
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

  return (
    <SidebarProvider defaultOpen={sidebarDefaultOpen} className="h-svh">
      <AppSidebar routeConfig={routeConfig} />
      <SidebarInset className="min-w-0 overflow-hidden">
        {/* The one "where am I" header: the current path (stream-aware, with
            sibling/child navigators) at the very top left, and the ⌘K stream
            switcher on the right. Pages never render their own path chrome. */}
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1 md:hidden" />
          <PathBreadcrumbs />
          <button
            type="button"
            aria-haspopup="dialog"
            title="Switch or create a stream — ⌘K"
            onClick={openGlobalCommandPalette}
            className="ml-auto flex shrink-0 cursor-pointer items-center gap-2 rounded-full bg-muted px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Streams
            <kbd className="rounded bg-background px-1.5 py-px text-[10px]">⌘K</kbd>
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          <Outlet />
        </div>
      </SidebarInset>
      <GlobalCommandPalette />
    </SidebarProvider>
  );
}
