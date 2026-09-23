// The dash's own navigation inside the shared shell (`AppShell`, packages/ui): inside a project its
// overview, MCP, secrets and its site; outside one the account's pages, THE TREE — the person's
// organizations, each with its projects (components/organization-tree.tsx, live) — and the other
// first-party apps.
import { Link, useMatchRoute } from "@tanstack/react-router";
import {
  Activity,
  Building2,
  ExternalLink,
  FolderKanban,
  KeyRound,
  LayoutDashboard,
  LockKeyhole,
  Plug,
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
import { APPS } from "../apps.ts";
import { useOrganizationTree } from "./organization-tree.tsx";

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
  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Overview"
              isActive={Boolean(
                matchRoute({
                  to: "/projects/$slug",
                  params: { slug: project.slug },
                  fuzzy: false,
                }),
              )}
              render={<Link to="/projects/$slug" params={{ slug: project.slug }} />}
            >
              <LayoutDashboard />
              <span>Overview</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="MCP"
              isActive={Boolean(
                matchRoute({
                  to: "/projects/$slug/mcp",
                  params: { slug: project.slug },
                  fuzzy: false,
                }),
              )}
              render={<Link to="/projects/$slug/mcp" params={{ slug: project.slug }} />}
            >
              <Plug />
              <span>MCP</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Secrets"
              isActive={Boolean(
                matchRoute({
                  to: "/projects/$slug/secrets",
                  params: { slug: project.slug },
                  fuzzy: false,
                }),
              )}
              render={<Link to="/projects/$slug/secrets" params={{ slug: project.slug }} />}
            >
              <LockKeyhole />
              <span>Secrets</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
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
          {APPS.map((app) => (
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
  return (
    <>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Projects"
                isActive={Boolean(matchRoute({ to: "/projects", fuzzy: false }))}
                render={<Link to="/projects" />}
              >
                <FolderKanban />
                <span>Projects</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Organizations"
                isActive={Boolean(matchRoute({ to: "/organizations", fuzzy: false }))}
                render={<Link to="/organizations" />}
              >
                <Building2 />
                <span>Organizations</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Sessions"
                isActive={Boolean(matchRoute({ to: "/sessions", fuzzy: false }))}
                render={<Link to="/sessions" />}
              >
                <KeyRound />
                <span>Sessions</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Activity"
                isActive={Boolean(matchRoute({ to: "/activity", fuzzy: false }))}
                render={<Link to="/activity" />}
              >
                <Activity />
                <span>Activity</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      <OrganizationTreeNav />
      <SidebarGroup>
        <SidebarGroupLabel>Apps</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {APPS.map((app) => (
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
            <SidebarMenuItem className="px-2 text-xs text-destructive">
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
                  <SidebarMenuSubItem className="px-2 text-xs text-destructive">
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
