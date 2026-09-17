// The dash's sidebar, the shape of apps/os's: a project switcher in the header, the active
// project's sections (or the top-level pages) in the body, theme + collapse + the account menu in
// the footer. Mobile renders it as a sheet (shadcn Sidebar), closed again on navigation.
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
import { SidebarThemeSwitcher } from "@iterate-com/ui/components/sidebar-theme-switcher";
import { APPS } from "../apps.ts";
import { OVERVIEW, PROJECT_SECTIONS } from "../sections.ts";
import { CloseMobileSidebarOnNavigate } from "./close-mobile-sidebar-on-navigate.tsx";

export type Org = { id: string; name: string; role?: string };
export type Project = { id: string; orgId: string; role?: string };

export function DashSidebar({
  orgs,
  projects,
  email,
}: {
  orgs: Org[];
  projects: Project[];
  email: string;
}) {
  const { projectId } = useParams({ strict: false });
  return (
    <>
      <CloseMobileSidebarOnNavigate />
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <ProjectSwitcher orgs={orgs} projects={projects} activeProjectId={projectId ?? null} />
        </SidebarHeader>
        <SidebarContent>
          {projectId ? <ProjectNav projectId={projectId} /> : <TopLevelNav />}
        </SidebarContent>
        <SidebarFooter>
          <SidebarThemeSwitcher />
          <CollapseButton />
          <AccountMenu email={email} />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
    </>
  );
}

/** Projects grouped by organization; a project whose organization this grant does not list
 *  (a narrowed grant) sits under "Other". */
export function projectsByOrg(orgs: Org[], projects: Project[]) {
  const groups = orgs.map((org) => ({
    org,
    projects: projects.filter((project) => project.orgId === org.id),
  }));
  const known = new Set(orgs.map((org) => org.id));
  const other = projects.filter((project) => !known.has(project.orgId));
  if (other.length) groups.push({ org: { id: "", name: "Other" }, projects: other });
  return groups.filter((group) => group.projects.length);
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
                    {activeProjectId ?? "(select project)"}
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

/** Inside a project: the overview and every section, in the registry's order. */
function ProjectNav({ projectId }: { projectId: string }) {
  const matchRoute = useMatchRoute();
  const overviewActive = Boolean(
    matchRoute({ to: "/projects/$projectId", params: { projectId }, fuzzy: false }),
  );
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Project</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={OVERVIEW.label}
              isActive={overviewActive}
              render={<Link to="/projects/$projectId" params={{ projectId }} />}
            >
              <OVERVIEW.icon />
              <span>{OVERVIEW.label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {PROJECT_SECTIONS.map((section) => (
            <SidebarMenuItem key={section.id}>
              <SidebarMenuButton
                tooltip={section.label}
                isActive={Boolean(
                  matchRoute({
                    to: "/projects/$projectId/$section",
                    params: { projectId, section: section.id },
                    fuzzy: false,
                  }),
                )}
                render={
                  <Link
                    to="/projects/$projectId/$section"
                    params={{ projectId, section: section.id }}
                  />
                }
              >
                <section.icon />
                <span>{section.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
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
                  render={<a href={app.url} target="_blank" rel="noreferrer" />}
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
        <form ref={logout} method="post" action="/.auth/logout" hidden />
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
            <DropdownMenuLabel className="truncate font-normal">{email}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem render={<Link to="/sessions" />}>
                <KeyRound />
                <span>Sessions and tokens</span>
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => logout.current?.requestSubmit()}>
              <LogOut />
              <span>Sign out</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
