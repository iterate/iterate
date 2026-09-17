// The dash's sidebar, the shape of apps/os's: the project switcher in the header, the pages that
// exist in the body — inside a project its overview and its site, outside one the projects and
// sessions pages and the other first-party apps — and the account menu in the footer. Mobile
// renders it as a sheet (shadcn Sidebar), closed again on navigation.
import { useRef } from "react";
import { Link, useMatchRoute, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  ChevronsLeft,
  ChevronsUpDown,
  ExternalLink,
  FolderKanban,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Plus,
} from "lucide-react";
import { Avatar, AvatarFallback } from "@iterate-com/ui/components/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@iterate-com/ui/components/dropdown-menu";
import { IterateLogo } from "@iterate-com/ui/components/iterate-logo";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@iterate-com/ui/components/sidebar";
import { APPS } from "../apps.ts";
import { projectsByOrg, type Org, type Project } from "../lib/projects.ts";
import { CloseMobileSidebarOnNavigate } from "./close-mobile-sidebar-on-navigate.tsx";

export function DashSidebar({
  orgs,
  projects,
  email,
  projectHost,
}: {
  orgs: Org[];
  projects: Project[];
  email: string;
  /** the project's own site (its config worker), null when this deployment has no project hosts */
  projectHost: (projectId: string) => string | null;
}) {
  const { projectId } = useParams({ strict: false });
  return (
    <>
      <CloseMobileSidebarOnNavigate />
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <ProjectSwitcher orgs={orgs} projects={projects} activeProjectId={projectId || null} />
        </SidebarHeader>
        <SidebarContent>
          {projectId ? (
            <ProjectNav projectId={projectId} host={projectHost(projectId)} />
          ) : (
            <TopLevelNav />
          )}
        </SidebarContent>
        <SidebarFooter>
          <CollapseButton />
          <AccountMenu email={email} />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
    </>
  );
}

function ProjectSwitcher({
  orgs,
  projects,
  activeProjectId,
}: {
  orgs: Org[];
  projects: Project[];
  activeProjectId: string | null;
}) {
  const { isMobile } = useSidebar();
  const groups = projectsByOrg(orgs, projects);
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground"
                aria-label="Switch project"
              >
                <span className="flex aspect-square size-8 items-center justify-center rounded-md bg-black">
                  <IterateLogo className="size-6" />
                </span>
                <span className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">iterate</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {activeProjectId || "(select project)"}
                  </span>
                </span>
                <ChevronsUpDown className="ml-auto" />
              </SidebarMenuButton>
            }
          />
          <DropdownMenuContent
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
            className="min-w-60 rounded-lg"
          >
            {groups.length ? (
              groups.map((group) => (
                <DropdownMenuGroup key={group.org.id || "other"}>
                  <DropdownMenuLabel className="text-xs text-muted-foreground">
                    {group.org.name}
                  </DropdownMenuLabel>
                  {group.projects.map((project) => (
                    <DropdownMenuItem
                      key={project.id}
                      className="gap-2 p-2"
                      render={
                        <Link
                          to="/projects/$projectId"
                          params={{ projectId: project.id }}
                          aria-label={`Switch to ${project.id}`}
                        />
                      }
                    >
                      <span className="flex size-6 items-center justify-center rounded-md border text-xs font-medium text-muted-foreground">
                        {project.id.slice(0, 1)}
                      </span>
                      <span className="truncate">{project.id}</span>
                      {project.id === activeProjectId ? <Check className="ml-auto" /> : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              ))
            ) : (
              <DropdownMenuItem disabled className="p-2">
                No projects yet
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem render={<Link to="/projects" hash="new" />}>
                <Plus />
                <span>Create project</span>
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link to="/projects" />}>
                <ArrowLeft />
                <span>All projects</span>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
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

/** Outside a project: the projects list, the account pages, and the other first-party apps. */
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

function CollapseButton() {
  const { state, toggleSidebar } = useSidebar();
  const collapsed = state === "collapsed";
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          type="button"
          size="sm"
          className="text-sidebar-foreground/70"
          tooltip={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={toggleSidebar}
        >
          <ChevronsLeft className={collapsed ? "rotate-180" : undefined} />
          <span>Collapse sidebar</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/** The signed-in person: sessions and personal access tokens, sign out (a POST to the app's own
 *  logout, which ends this browser's grant at the issuer). */
function AccountMenu({ email }: { email: string }) {
  const { isMobile } = useSidebar();
  const logout = useRef<HTMLFormElement>(null);
  const initials = email.slice(0, 2).toUpperCase();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground"
                aria-label="Account"
              >
                <Avatar className="size-8 rounded-lg">
                  <AvatarFallback className="rounded-lg">{initials}</AvatarFallback>
                </Avatar>
                <span className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{email}</span>
                  <span className="truncate text-xs text-muted-foreground">Signed in</span>
                </span>
                <ChevronsUpDown className="ml-auto" />
              </SidebarMenuButton>
            }
          />
          <DropdownMenuContent
            className="min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            {/* Base UI: a menu label lives inside a group, never bare in the menu */}
            <DropdownMenuGroup>
              <DropdownMenuLabel className="truncate font-normal">{email}</DropdownMenuLabel>
              <DropdownMenuItem render={<Link to="/sessions" />}>
                <KeyRound />
                <span>Sessions and tokens</span>
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => logout.current?.requestSubmit()}>
                <LogOut />
                <span>Sign out</span>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
      {/* the sign-out POST, outside the menu item so nothing but the item's click submits it */}
      <form ref={logout} method="post" action="/.auth/logout" hidden />
    </SidebarMenu>
  );
}
