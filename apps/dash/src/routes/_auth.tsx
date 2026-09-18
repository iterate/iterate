// The signed-in shell: authenticate once (the SDK client; a missing session leaves for the issuer's
// login), load what every page shares — the person's organizations and projects — and frame every
// child in the shared `AppShell` (packages/ui, the same frame agents, notes and voice use). Consent
// is task-based: the dash asks for `iterate`, `account` and `organizations:write`, the person may
// untick the optional two, and the pages read `info.scopes` for what they may do.
import {
  createFileRoute,
  Link,
  Outlet,
  useMatches,
  useParams,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { ArrowLeft, KeyRound, Plus } from "lucide-react";
import { createIterateClient } from "iterate/next/app";
import { AppShell } from "@iterate-com/ui/components/app-shell";
import { DropdownMenuItem } from "@iterate-com/ui/components/dropdown-menu";
import { DashBreadcrumbs } from "../components/dash-breadcrumbs.tsx";
import { DashNav } from "../components/dash-nav.tsx";
import { projectsByOrg } from "../lib/projects.ts";

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

function Shell() {
  const { orgs, projects } = Route.useLoaderData();
  const { info } = Route.useRouteContext();
  const router = useRouter();
  const href = useRouterState({ select: (state) => state.location.href });
  const { projectId } = useParams({ strict: false });
  const matches = useMatches();
  const page = matches
    .map((match) => match.staticData.page)
    .filter((label): label is string => Boolean(label))
    .at(-1);
  return (
    <AppShell
      app="iterate"
      // the switcher lists projects by organization, in the organizations' order
      projects={projectsByOrg(orgs, projects).flatMap((group) =>
        group.projects.map((project) => ({
          id: project.id,
          slug: project.slug,
          org: { id: group.org.id, name: group.org.name },
        })),
      )}
      activeProjectId={projectId || null}
      projectHref={(id) => `/projects/${id}`}
      // the dash has a client router: a plain click on a switcher item is a route change, not a
      // page load (the shell leaves modified and middle clicks to the anchor)
      onNavigate={(to, event) => {
        event.preventDefault();
        void router.navigate({ href: to });
      }}
      switcherActions={
        <>
          <DropdownMenuItem render={<Link to="/projects" search={{ new: 1 }} />}>
            <Plus />
            <span>New project</span>
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link to="/projects" />}>
            <ArrowLeft />
            <span>All projects</span>
          </DropdownMenuItem>
        </>
      }
      nav={
        <DashNav
          projectId={projectId || null}
          // a project's site is at its slug, never its id
          projectHost={(id) => {
            const slug = projects.find((project) => project.id === id)?.slug;
            return slug ? projectHostOf(info, slug) : null;
          }}
        />
      }
      header={<DashBreadcrumbs orgs={orgs} projects={projects} page={page} />}
      account={{ email: info.principal.email || info.principal.actor }}
      accountActions={
        <DropdownMenuItem render={<Link to="/sessions" />}>
          <KeyRound />
          <span>Sessions</span>
        </DropdownMenuItem>
      }
      locationKey={href}
    >
      <Outlet />
    </AppShell>
  );
}
