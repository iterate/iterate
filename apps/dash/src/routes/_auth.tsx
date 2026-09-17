// The signed-in shell: authenticate once (the SDK client; a missing session leaves for the issuer's
// login), load what every page shares — the person's organizations and projects — and frame every
// child in the sidebar + header. Consent is task-based: the dash asks for `iterate`, `account` and
// `organizations:write`, the person may untick the optional two, and the pages read `info.scopes`
// for what they may do.
import { createFileRoute, Outlet, useMatches } from "@tanstack/react-router";
import { createIterateClient } from "iterate/next/app";
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

/** A project's own site: `<project>.<base>` on the platform's scheme and port — null when the
 *  deployment serves no project hosts. */
export function projectHostOf(
  info: { platformOrigin: string; projectHostnameBase: string | null | undefined },
  projectId: string,
) {
  if (!info.projectHostnameBase) return null;
  const origin = new URL(info.platformOrigin);
  return `${origin.protocol}//${projectId}.${info.projectHostnameBase}${origin.port ? `:${origin.port}` : ""}/`;
}

/** The shell is apps/os's (`apps/os/src/routes/_app.tsx`): the same Sidebar from packages/ui, the
 *  same minimal header — the trigger on phones only (desktop collapses from the footer and the
 *  rail), the page's label beside it — and the sidebar's open state remembered the way shadcn's
 *  provider remembers it (its `sidebar_state` cookie; this shell is client-only, so it reads it). */
function Shell() {
  const { orgs, projects } = Route.useLoaderData();
  const { info } = Route.useRouteContext();
  const matches = useMatches();
  const page = matches
    .map((match) => match.staticData.page)
    .filter((label): label is string => Boolean(label))
    .at(-1);
  const defaultOpen = !document.cookie.split("; ").includes("sidebar_state=false");
  return (
    <SidebarProvider defaultOpen={defaultOpen} className="h-svh">
      <DashSidebar
        orgs={orgs}
        projects={projects}
        email={info.principal.email || info.principal.actor}
        projectHost={(projectId) => projectHostOf(info, projectId)}
      />
      <SidebarInset className="min-w-0 overflow-hidden">
        <header className="flex shrink-0 items-center gap-3 px-4 pt-2.5 pb-1">
          <SidebarTrigger className="-ml-1 md:hidden" />
          <DashBreadcrumbs orgs={orgs} projects={projects} page={page} />
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
