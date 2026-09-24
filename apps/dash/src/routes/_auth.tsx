// The signed-in shell: authenticate once (the SDK client; a missing session leaves for the issuer's
// login), open the tree every page shares — the person's organizations and their projects, LIVE
// (components/organization-tree.tsx) — and frame every child in the shared `AppShell` (packages/ui,
// the same frame agents, notes and voice use). Consent is task-based: the dash asks for `iterate`,
// `account` and `organizations:write`, the person may untick the optional two, and the pages read
// `info.scopes` for what they may do.
import {
  createFileRoute,
  Link,
  Outlet,
  useMatch,
  useMatches,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { ArrowLeft, KeyRound, Plus } from "lucide-react";
import { useMemo } from "react";
import { z } from "zod";
import { createIterateClient } from "iterate/next/app";
import { AppShell } from "@iterate-com/ui/components/app-shell";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@iterate-com/ui/components/dropdown-menu";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { usePosthogIdentity, type PosthogGroup } from "@iterate-com/ui/components/posthog";
import { DashBreadcrumbs } from "../components/dash-breadcrumbs.tsx";
import { DashNav } from "../components/dash-nav.tsx";
import { OrganizationTree, useOrganizationTree } from "../components/organization-tree.tsx";
import { projectHostOf } from "../lib/origins.ts";
import { dashScopes } from "../lib/scopes.ts";

const iterate = createIterateClient({ scopes: dashScopes });

export const Route = createFileRoute("/_auth")({
  ssr: false,
  beforeLoad: ({ location }) => iterate.authenticate(location.href),
  // which issuer this browser is connected to (the gate's `/.auth/session.json`): the shell says
  // so whenever it is not the deployment's own, so a person can tell their self-host from ours;
  // a gate that does not answer leaves the label off
  loader: async () => ({
    issuerHost: await fetch("/.auth/session.json", { headers: { accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) return null;
        const session = z
          .object({ issuer: z.string().nullable(), defaultIssuer: z.string() })
          .parse(await response.json());
        return session.issuer && session.issuer !== session.defaultIssuer
          ? new URL(session.issuer).host
          : null;
      })
      .catch(() => null),
  }),
  component: Shell,
});

function Shell() {
  const { issuerHost } = Route.useLoaderData();
  const { api, info } = Route.useRouteContext();
  const router = useRouter();
  const href = useRouterState({ select: (state) => state.location.href });
  const tree = useOrganizationTree();
  // inside a project: the one its route resolved (projects/$slug/route.tsx)
  const active = useMatch({ from: "/_auth/projects/$slug", shouldThrow: false })?.context.project;
  const matches = useMatches();
  const page = matches
    .map((match) => match.staticData.page)
    .filter((label): label is string => Boolean(label))
    .at(-1);
  // PostHog: the person is the platform user id (the same person in every app); the groups are the
  // project on screen and its organization, keyed by id (docs: organization, then project).
  const activeOrg = active && tree.organizations.find((org) => org.id === active.orgId);
  const posthogGroups = useMemo(
    (): PosthogGroup[] =>
      active
        ? [
            ...(activeOrg
              ? [{ type: "organization", key: activeOrg.id, properties: { name: activeOrg.name } }]
              : []),
            { type: "project", key: active.id, properties: { slug: active.slug } },
          ]
        : [],
    [active, activeOrg],
  );
  usePosthogIdentity(info.principal, posthogGroups);
  return (
    <>
      <OrganizationTree api={api} info={info} />
      <AppShell
        app="iterate"
        // the switcher lists projects by organization, in the tree's order
        projects={tree.organizations.flatMap((org) =>
          org.projects.map((project) => ({
            id: project.id,
            slug: project.slug,
            org: { id: org.id, name: org.name },
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
          <DashNav
            project={active || null}
            host={active ? projectHostOf(info, active.slug) : null}
          />
        }
        header={
          <>
            <DashBreadcrumbs project={active || null} page={page} />
            {issuerHost && (
              <span className="ml-auto text-xs text-muted-foreground">
                Connected to {issuerHost}
              </span>
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
    </>
  );
}
