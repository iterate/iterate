import { Outlet, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { Separator } from "@iterate-com/ui/components/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { AppSidebar } from "~/components/app-sidebar.tsx";
import { PathBreadcrumbs } from "~/components/path-breadcrumbs.tsx";
import { requireActiveOrganizationForOrgRoute } from "~/lib/auth.ts";
import { orpc } from "~/orpc/client.ts";

const getSidebarDefaultOpen = createServerFn({ method: "GET" }).handler(() => ({
  defaultOpen: !/(?:^|;\s*)sidebar_state=false(?:;|$)/.test(getRequestHeader("cookie") ?? ""),
}));

export const Route = createFileRoute("/_app/orgs/$organizationSlug")({
  beforeLoad: ({ params }) =>
    requireActiveOrganizationForOrgRoute({
      data: { organizationSlug: params.organizationSlug },
    }),
  loader: async ({ context }) => {
    const projectsQuery = orpc.projects.list.queryOptions({ input: { limit: 100, offset: 0 } });
    await context.queryClient.ensureQueryData({
      ...projectsQuery,
      staleTime: 30_000,
    });

    return {
      sidebarDefaultOpen: (await getSidebarDefaultOpen()).defaultOpen,
    };
  },
  component: OrganizationLayout,
});

function OrganizationLayout() {
  const params = Route.useParams();
  const { sidebarDefaultOpen } = Route.useLoaderData();

  return (
    <SidebarProvider defaultOpen={sidebarDefaultOpen} className="h-svh">
      <AppSidebar organizationSlug={params.organizationSlug} />
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
