import { Outlet, createFileRoute, useMatches } from "@tanstack/react-router";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { requireOrganizationMemberForSession } from "../lib/auth.ts";
import { AppSidebar } from "~/components/app-sidebar.tsx";
import { GlobalCommandPalette } from "~/components/global-command-palette.tsx";
import { openGlobalCommandPalette } from "~/components/global-command-palette-events.ts";
import { getPublicRouteConfig } from "~/lib/public-route-config.ts";
import {
  activeStreamBreadcrumb,
  type RouteBreadcrumbLoaderData,
  type RouteBreadcrumbStaticData,
} from "~/lib/route-breadcrumbs.ts";
import { getSidebarDefaultOpen } from "~/lib/sidebar-state.ts";

export const Route = createFileRoute("/_app")({
  beforeLoad: ({ context, location }) =>
    requireOrganizationMemberForSession(
      context.authSession,
      location,
      context.iterateAuthIssuer,
      context.authError,
      context.appOrigin,
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
  const matches = useMatches();
  // Stream pages render THE header themselves (the pill path breadcrumb +
  // presence + Feed/State inside the stream view) — a page publishing a
  // streamBreadcrumb IS a stream page. Only the few non-stream pages
  // (projects list, new-project, session REPL) get this minimal shell header.
  // Project routes are client-only, so their loader data is absent from the
  // server render. Static route data keeps the shell's first client render
  // identical to SSR; the loader breadcrumb takes over after the route loads.
  const isStreamPage =
    matches.some(
      (match) => (match.staticData as RouteBreadcrumbStaticData | undefined)?.streamPage === true,
    ) || activeStreamBreadcrumb(matches) != null;
  // The projects list is the one app page with no project context, so the
  // stream ⌘K switcher has nothing to act on — hide its pill and don't mount
  // the palette here, which also drops its global ⌘K key handler.
  const isProjectsListPage = matches.at(-1)?.routeId === "/_app/projects/";
  const label = matches
    .map(
      (match) =>
        (match.loaderData as RouteBreadcrumbLoaderData | undefined)?.breadcrumb ??
        (match.staticData as RouteBreadcrumbStaticData | undefined)?.breadcrumb,
    )
    .filter(Boolean)
    .at(-1);

  return (
    <SidebarProvider defaultOpen={sidebarDefaultOpen} className="h-svh">
      <AppSidebar routeConfig={routeConfig} />
      <SidebarInset className="min-w-0 overflow-hidden">
        {isStreamPage ? null : (
          <header className="flex shrink-0 items-center gap-3 px-4 pb-1 pt-2.5">
            <SidebarTrigger className="-ml-1 md:hidden" />
            {label ? <span className="truncate text-sm font-medium">{label}</span> : null}
            {isProjectsListPage ? null : (
              <button
                type="button"
                aria-haspopup="dialog"
                title="Switch or create a stream — ⌘K"
                onClick={openGlobalCommandPalette}
                className="ml-auto flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-full bg-muted px-3.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                Streams
                <kbd className="rounded bg-background px-1.5 py-px text-[10px]">⌘K</kbd>
              </button>
            )}
          </header>
        )}
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          <Outlet />
        </div>
      </SidebarInset>
      {isProjectsListPage ? null : <GlobalCommandPalette />}
    </SidebarProvider>
  );
}
