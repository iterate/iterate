// The dash's own navigation inside the shared shell (`AppShell`, packages/ui): inside a project its
// overview and its site; outside one the projects, organizations and sessions pages and the other
// first-party apps.
import { Link, useMatchRoute } from "@tanstack/react-router";
import { Building2, ExternalLink, FolderKanban, KeyRound, LayoutDashboard } from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@iterate-com/ui/components/sidebar";
import { APPS } from "../apps.ts";

export function DashNav({
  projectId,
  projectHost,
}: {
  projectId: string | null;
  /** the project's own site (its config worker), null when this deployment has no project hosts */
  projectHost: (projectId: string) => string | null;
}) {
  return projectId ? (
    <ProjectNav projectId={projectId} host={projectHost(projectId)} />
  ) : (
    <TopLevelNav />
  );
}

/** Inside a project: what the dash has for it today — its overview, and its own site. */
function ProjectNav({ projectId, host }: { projectId: string; host: string | null }) {
  const matchRoute = useMatchRoute();
  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Overview"
              isActive={Boolean(
                matchRoute({ to: "/projects/$projectId", params: { projectId }, fuzzy: false }),
              )}
              render={<Link to="/projects/$projectId" params={{ projectId }} />}
            >
              <LayoutDashboard />
              <span>Overview</span>
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
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

/** Outside a project: the projects and organizations lists, the account pages, and the other
 *  first-party apps. */
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
                isActive={Boolean(matchRoute({ to: "/organizations", fuzzy: true }))}
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
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
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
