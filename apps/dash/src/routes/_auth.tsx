// The signed-in shell: authenticate once (the SDK client; a missing session leaves for the login
// door of the issuer), load what every page shares — the person's organizations and projects — and
// frame every child in the sidebar + header. Consent is task-based: the dash asks for `iterate`,
// `account` and `organizations:write`, the person may untick the optional two, and the pages read
// `info.scopes` for what they may do.
import { createFileRoute, Outlet, useMatches } from "@tanstack/react-router";
import { createIterateClient } from "iterate/next/app";
import { Separator } from "@iterate-com/ui/components/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { DashBreadcrumbs } from "../components/dash-breadcrumbs.tsx";
import { DashSidebar } from "../components/dash-sidebar.tsx";

const iterate = createIterateClient({ scopes: ["iterate", "account", "organizations:write"] });

export const Route = createFileRoute("/_auth")({
  ssr: false,
  beforeLoad: ({ location }) => iterate.authenticate(location.href),
  loader: async ({ context }) => {
    const [orgs, projects] = await Promise.all([context.api.orgs(), context.api.projects.list()]);
    return { orgs, projects };
  },
  component: Shell,
});

function Shell() {
  const { orgs, projects } = Route.useLoaderData();
  const { info } = Route.useRouteContext();
  const matches = useMatches();
  const page = matches
    .map((match) => (match.staticData as { page?: string } | undefined)?.page)
    .filter((label): label is string => Boolean(label))
    .at(-1);
  return (
    <SidebarProvider className="h-svh">
      <DashSidebar
        orgs={orgs}
        projects={projects}
        email={info.principal.email || info.principal.actor}
      />
      <SidebarInset className="min-w-0 overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3 md:px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
          <DashBreadcrumbs orgs={orgs} projects={projects} page={page} />
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
