// The dash's own navigation inside the shared shell (`AppShell`, packages/ui): inside a project its
// overview, contexts (any context's log, live), MCP, secrets and its site; outside one the account's pages, THE TREE — the person's
// organizations, each with its projects (components/organization-tree.tsx, live) — and the other
// first-party apps.
import { getRouteApi, Link, useMatchRoute } from "@tanstack/react-router";
import {
  Activity,
  Blocks,
  Building2,
  ExternalLink,
  FolderKanban,
  Globe,
  KeyRound,
  LayoutDashboard,
  LockKeyhole,
  Plug,
  Waypoints,
} from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@iterate-com/ui/components/sidebar";
import { useOrganizationTree } from "./organization-tree.tsx";

/** The root loader's: the directory of apps this deployment has (apps.ts `appDirectory`). */
const root = getRouteApi("__root__");

const PROJECT_PAGES = [
  { to: "/projects/$slug", label: "Overview", icon: LayoutDashboard },
  { to: "/projects/$slug/contexts/$", label: "Contexts", icon: Waypoints },
  { to: "/projects/$slug/mcp", label: "MCP", icon: Plug },
  { to: "/projects/$slug/secrets", label: "Secrets", icon: LockKeyhole },
  { to: "/projects/$slug/integrations", label: "Integrations", icon: Blocks },
  { to: "/projects/$slug/hostnames", label: "Hostnames", icon: Globe },
] as const;

const ACCOUNT_PAGES = [
  { to: "/projects", label: "Projects", icon: FolderKanban },
  { to: "/organizations", label: "Organizations", icon: Building2 },
  { to: "/sessions", label: "Sessions", icon: KeyRound },
  { to: "/activity", label: "Activity", icon: Activity },
] as const;

export function DashNav({
  project,
  host,
}: {
  project: { id: string; slug: string } | null;
  /** the project's own site (its config worker), null when this deployment has no project hosts */
  host: string | null;
}) {
  return project ? <ProjectNav project={project} host={host} /> : <TopLevelNav />;
}

/** Inside a project: its overview, how to connect over MCP, its secrets, its own site, and the first-party apps
 *  opened on it — every app
 *  serves `/projects/<slug>`, so the links are the convention, and a signed-out click proves the
 *  apps' OAuth returns to the deep link. */
function ProjectNav({
  project,
  host,
}: {
  project: { id: string; slug: string };
  host: string | null;
}) {
  const matchRoute = useMatchRoute();
  const { apps } = root.useLoaderData();
  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {PROJECT_PAGES.map(({ to, label, icon: Icon }) => (
            <SidebarMenuItem key={to}>
              <SidebarMenuButton
                tooltip={label}
                // Contexts is a splat (`/contexts/<any context path>`): active on every path under
                // it; the others only on their own page, so Overview is not lit everywhere
                isActive={Boolean(
                  matchRoute({
                    to,
                    params: { slug: project.slug },
                    fuzzy: to === "/projects/$slug/contexts/$",
                  }),
                )}
                render={<Link to={to} params={{ slug: project.slug }} />}
              >
                <Icon />
                <span>{label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          {host ? (
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip={new URL(host).host}
                render={
                  <a
                    href={host}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open ${new URL(host).host}`}
                  />
                }
              >
                <ExternalLink />
                <span>Project site</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : null}
          {apps.map((app) => (
            <SidebarMenuItem key={app.url}>
              <SidebarMenuButton
                tooltip={`${app.name} for ${project.slug}`}
                render={
                  <a
                    href={`${app.url}/projects/${project.slug}`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`${app.name} for ${project.slug}`}
                  />
                }
              >
                <ExternalLink />
                <span>{app.name}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

/** Outside a project: the projects and organizations lists, the account pages; the tree — every
 *  organization the person belongs to, its projects under it; and the other first-party apps. */
function TopLevelNav() {
  const matchRoute = useMatchRoute();
  const { apps } = root.useLoaderData();
  return (
    <>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            {ACCOUNT_PAGES.map(({ to, label, icon: Icon }) => (
              <SidebarMenuItem key={to}>
                <SidebarMenuButton
                  tooltip={label}
                  isActive={Boolean(matchRoute({ to, fuzzy: false }))}
                  render={<Link to={to} />}
                >
                  <Icon />
                  <span>{label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      <OrganizationTreeNav />
      {apps.length ? (
        <SidebarGroup>
          <SidebarGroupLabel>Apps</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {apps.map((app) => (
                <SidebarMenuItem key={app.url}>
                  <SidebarMenuButton
                    tooltip={app.name}
                    render={
                      <a href={app.url} target="_blank" rel="noreferrer" aria-label={app.name} />
                    }
                  >
                    <ExternalLink />
                    <span>{app.name}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ) : null}
    </>
  );
}

/** The tree: each organization the person belongs to (→ its settings), its projects under it
 *  (→ each overview). Skeleton rows while the account's memberships are still connecting. */
function OrganizationTreeNav() {
  const tree = useOrganizationTree();
  const matchRoute = useMatchRoute();
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Your organizations</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {!tree.loaded && !tree.organizations.length ? (
            <SidebarMenuItem>
              <SidebarMenuSkeleton showIcon />
            </SidebarMenuItem>
          ) : null}
          {tree.error ? (
            <SidebarMenuItem data-type="error" className="px-2 text-xs text-destructive">
              {tree.error}
            </SidebarMenuItem>
          ) : null}
          {tree.loaded && !tree.organizations.length && !tree.error ? (
            <SidebarMenuItem className="px-2 text-xs text-muted-foreground">
              No organizations yet
            </SidebarMenuItem>
          ) : null}
          {tree.organizations.map((org) => (
            <SidebarMenuItem key={org.id}>
              <SidebarMenuButton
                tooltip={org.name}
                isActive={Boolean(
                  matchRoute({
                    to: "/organizations/$orgId",
                    params: { orgId: org.id },
                    fuzzy: true,
                  }),
                )}
                render={<Link to="/organizations/$orgId" params={{ orgId: org.id }} />}
              >
                <Building2 />
                <span>{org.name}</span>
              </SidebarMenuButton>
              {org.error ? (
                <SidebarMenuSub>
                  <SidebarMenuSubItem data-type="error" className="px-2 text-xs text-destructive">
                    {org.error}
                  </SidebarMenuSubItem>
                </SidebarMenuSub>
              ) : org.projects.length ? (
                <SidebarMenuSub>
                  {org.projects.map((project) => (
                    <SidebarMenuSubItem key={project.id}>
                      <SidebarMenuSubButton
                        isActive={Boolean(
                          matchRoute({
                            to: "/projects/$slug",
                            params: { slug: project.slug },
                            fuzzy: true,
                          }),
                        )}
                        className="font-mono"
                        render={<Link to="/projects/$slug" params={{ slug: project.slug }} />}
                      >
                        <span>{project.slug}</span>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  ))}
                </SidebarMenuSub>
              ) : null}
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
