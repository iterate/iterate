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
import { useEffect, useState } from "react";
import { ArrowLeft, KeyRound, Plus } from "lucide-react";
import { createIterateClient } from "iterate/next/app";
import { projectUrlOf, type IngressRouting } from "iterate/next/project-ingress";
import { AppShell } from "@iterate-com/ui/components/app-shell";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@iterate-com/ui/components/dropdown-menu";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { DashBreadcrumbs } from "../components/dash-breadcrumbs.tsx";
import { DashNav } from "../components/dash-nav.tsx";
import { httpOriginOf } from "../lib/origins.ts";
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

/** A project's own site under this deployment's ingress (`projectUrlOf`) — null when the deployment
 *  serves no project hosts. The slug, never the id: the id is how a project is addressed, the slug is
 *  its label in a hostname or a path. The platform's origin is parsed first: it comes from the
 *  issuer's `info()`, and only an http(s) origin may become an href. */
export function projectHostOf(
  info: { platformOrigin: string; ingressRouting: IngressRouting },
  slug: string,
) {
  const origin = httpOriginOf(info.platformOrigin);
  return origin
    ? (projectUrlOf(info.ingressRouting, origin, { project: slug })?.href ?? null)
    : null;
}

function Shell() {
  const { orgs, projects } = Route.useLoaderData();
  const { info } = Route.useRouteContext();
  const router = useRouter();
  const href = useRouterState({ select: (state) => state.location.href });
  const { slug } = useParams({ strict: false });
  // which issuer this browser is connected to (the gate's `/.auth/session.json`): the shell says so
  // whenever it is not the deployment's own, so a person can tell their self-host from ours
  const [issuerHost, setIssuerHost] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/.auth/session.json", { headers: { accept: "application/json" } })
      .then((response) =>
        response.ok
          ? (response.json() as Promise<{ issuer: string | null; defaultIssuer: string }>)
          : null,
      )
      .then((session) => {
        if (cancelled || !session?.issuer || session.issuer === session.defaultIssuer) return;
        setIssuerHost(new URL(session.issuer).host);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  // the URL names a project by slug (its id works too)
  const active = projects.find((project) => project.slug === slug || project.id === slug);
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
      activeProjectId={active?.id || null}
      projectHref={(project) => `/projects/${project.slug}`}
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
        <DashNav project={active || null} host={active ? projectHostOf(info, active.slug) : null} />
      }
      header={
        <>
          <DashBreadcrumbs orgs={orgs} projects={projects} page={page} />
          {issuerHost && (
            <span className="ml-auto text-xs text-muted-foreground">Connected to {issuerHost}</span>
          )}
        </>
      }
      account={{ email: info.principal.email || info.principal.actor }}
      accountActions={
        <>
          {/* the person's id, copyable (Base UI: a menu label lives inside a group) */}
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              <Identifier value={info.principal.actor} textClassName="text-xs" />
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuItem render={<Link to="/sessions" />}>
            <KeyRound />
            <span>Sessions</span>
          </DropdownMenuItem>
        </>
      }
      locationKey={href}
    >
      <Outlet />
    </AppShell>
  );
}
