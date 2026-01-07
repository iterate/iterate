import { ClientOnly, Link, useLocation } from "@tanstack/react-router";
import {
  Building2,
  Settings,
  Users,
  Plug,
  Box,
  KeyRound,
  GitBranch,
  SlidersHorizontal,
  Bot,
  ChevronDown,
  Plus,
  LogOut,
  Server,
} from "lucide-react";
import { signOut } from "../lib/auth-client.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
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
} from "./ui/sidebar.tsx";
import { ThemeSwitcher } from "./theme-switcher.tsx";

interface SidebarProps {
  organizations: Array<{
    id: string;
    name: string;
    slug: string;
    projects: Array<{
      id: string;
      name: string;
      slug: string;
    }>;
  }>;
  currentOrg?: {
    id: string;
    name: string;
    slug: string;
    projects: Array<{
      id: string;
      name: string;
      slug: string;
    }>;
  };
  currentProject?: {
    id: string;
    name: string;
    slug: string;
  };
  user: {
    name: string;
    email: string;
    image?: string | null;
    role?: string;
  };
}

export function AppSidebar({ organizations, currentOrg, currentProject, user }: SidebarProps) {
  const location = useLocation();

  const org = currentOrg || organizations[0];
  const projects = org?.projects || [];
  const project = currentProject || projects[0];

  const projectBasePath = org && project ? `/orgs/${org.slug}/projects/${project.slug}` : "";
  const machinesPath = projectBasePath ? `${projectBasePath}/machines` : "";
  const connectorsPath = projectBasePath ? `${projectBasePath}/connectors` : "";
  const repoPath = projectBasePath ? `${projectBasePath}/repo` : "";
  const envVarsPath = projectBasePath ? `${projectBasePath}/env-vars` : "";
  const projectSettingsPath = projectBasePath ? `${projectBasePath}/settings` : "";
  const agentsPath = projectBasePath ? `${projectBasePath}/agents` : "";
  const accessTokensPath = projectBasePath;
  const teamPath = org ? `/orgs/${org.slug}/team` : "";

  const isMachinesActive =
    machinesPath.length > 0 &&
    (location.pathname === machinesPath || location.pathname === `${machinesPath}/`);
  const isConnectorsActive = connectorsPath.length > 0 && location.pathname === connectorsPath;
  const isRepoActive = repoPath.length > 0 && location.pathname === repoPath;
  const isEnvVarsActive = envVarsPath.length > 0 && location.pathname === envVarsPath;
  const isSettingsActive = projectSettingsPath.length > 0 && location.pathname === projectSettingsPath;
  const isAgentsActive = agentsPath.length > 0 && location.pathname === agentsPath;
  const isAccessTokensActive =
    accessTokensPath.length > 0 &&
    (location.pathname === accessTokensPath || location.pathname === `${accessTokensPath}/`);
  const isTeamActive = teamPath.length > 0 && location.pathname === teamPath;

  return (
    <Sidebar>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg">
                  <div className="flex items-center gap-2 min-w-0">
                    <Building2 className="h-4 w-4" />
                    <span className="truncate">{org?.name || "Select organization"}</span>
                  </div>
                  <ChevronDown className="ml-auto h-4 w-4" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-64" align="start">
                {organizations.map((organization) => (
                  <DropdownMenuSub key={organization.id}>
                    <DropdownMenuSubTrigger className="gap-2">
                      <span className="truncate">{organization.name}</span>
                      <Link
                        to="/orgs/$organizationSlug/settings"
                        params={{ organizationSlug: organization.slug }}
                        className="ml-auto text-muted-foreground hover:text-foreground"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <Settings className="h-4 w-4" />
                      </Link>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-64">
                      {organization.projects.map((proj) => (
                        <DropdownMenuItem key={proj.id} asChild>
                          <Link
                            to="/orgs/$organizationSlug/projects/$projectSlug"
                            params={{ organizationSlug: organization.slug, projectSlug: proj.slug }}
                          >
                            {proj.name}
                          </Link>
                        </DropdownMenuItem>
                      ))}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem asChild>
                        <Link
                          to="/orgs/$organizationSlug/projects/new"
                          params={{ organizationSlug: organization.slug }}
                        >
                          <Plus className="h-4 w-4 mr-2" />
                          Add project
                        </Link>
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to="/new-organization">
                    <Plus className="h-4 w-4 mr-2" />
                    New organization
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {org && (
          <SidebarGroup>
            <SidebarGroupLabel>Project</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  {projects.length > 1 ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <SidebarMenuButton size="lg">
                          <div className="flex items-center gap-2 min-w-0">
                            <Box className="h-4 w-4" />
                            <span className="truncate">{project?.name || "Select project"}</span>
                          </div>
                          <ChevronDown className="ml-auto h-4 w-4" />
                        </SidebarMenuButton>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent className="w-64" align="start">
                        {projects.map((proj) => (
                          <DropdownMenuItem key={proj.id} asChild>
                            <Link
                              to="/orgs/$organizationSlug/projects/$projectSlug"
                              params={{ organizationSlug: org.slug, projectSlug: proj.slug }}
                            >
                              {proj.name}
                            </Link>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : (
                    <SidebarMenuButton size="lg" disabled>
                      <div className="flex items-center gap-2 min-w-0">
                        <Box className="h-4 w-4" />
                        <span className="truncate">{project?.name || "Select project"}</span>
                      </div>
                    </SidebarMenuButton>
                  )}
                </SidebarMenuItem>
                {project && (
                  <>
                    <SidebarMenuItem>
                      <SidebarMenuButton asChild isActive={isAccessTokensActive}>
                        <Link
                          to="/orgs/$organizationSlug/projects/$projectSlug"
                          params={{ organizationSlug: org.slug, projectSlug: project.slug }}
                        >
                          <KeyRound className="h-4 w-4" />
                          <span>Access tokens</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton asChild isActive={isMachinesActive}>
                        <Link
                          to="/orgs/$organizationSlug/projects/$projectSlug/machines"
                          params={{ organizationSlug: org.slug, projectSlug: project.slug }}
                        >
                          <Server className="h-4 w-4" />
                          <span>Machines</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton asChild isActive={isRepoActive}>
                        <Link
                          to="/orgs/$organizationSlug/projects/$projectSlug/repo"
                          params={{ organizationSlug: org.slug, projectSlug: project.slug }}
                        >
                          <GitBranch className="h-4 w-4" />
                          <span>Repo</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton asChild isActive={isConnectorsActive}>
                        <Link
                          to="/orgs/$organizationSlug/projects/$projectSlug/connectors"
                          params={{ organizationSlug: org.slug, projectSlug: project.slug }}
                        >
                          <Plug className="h-4 w-4" />
                          <span>Connectors</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton asChild isActive={isEnvVarsActive}>
                        <Link
                          to="/orgs/$organizationSlug/projects/$projectSlug/env-vars"
                          params={{ organizationSlug: org.slug, projectSlug: project.slug }}
                        >
                          <SlidersHorizontal className="h-4 w-4" />
                          <span>Env vars</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton asChild isActive={isSettingsActive}>
                        <Link
                          to="/orgs/$organizationSlug/projects/$projectSlug/settings"
                          params={{ organizationSlug: org.slug, projectSlug: project.slug }}
                        >
                          <Settings className="h-4 w-4" />
                          <span>Settings</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton asChild isActive={isAgentsActive}>
                        <Link
                          to="/orgs/$organizationSlug/projects/$projectSlug/agents"
                          params={{ organizationSlug: org.slug, projectSlug: project.slug }}
                        >
                          <Bot className="h-4 w-4" />
                          <span>Agents</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
        {org && (
          <SidebarGroup>
            <SidebarGroupLabel>Organization</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={isTeamActive}>
                    <Link to="/orgs/$organizationSlug/team" params={{ organizationSlug: org.slug }}>
                      <Users className="h-4 w-4" />
                      <span>Team</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter>
        <ClientOnly>
          <ThemeSwitcher />
        </ClientOnly>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg">
                  {user.image ? (
                    <img src={user.image} alt={user.name} className="h-7 w-7 rounded-full" />
                  ) : (
                    <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center text-xs">
                      {user.name[0]}
                    </div>
                  )}
                  <div className="grid min-w-0 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{user.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{user.email}</span>
                  </div>
                  <ChevronDown className="ml-auto h-4 w-4" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
                <DropdownMenuContent className="w-56" side="right" align="end">
                  <DropdownMenuItem asChild>
                    <Link to="/user/settings">
                      <Settings className="h-4 w-4 mr-2" />
                      User settings
                    </Link>
                  </DropdownMenuItem>
                  {user.role === "admin" && (
                    <DropdownMenuItem asChild>
                      <Link to="/admin">
                        <Box className="h-4 w-4 mr-2" />
                        Admin
                      </Link>
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => {
                      signOut().then(() => {
                      window.location.href = "/login";
                    });
                  }}
                >
                  <LogOut className="h-4 w-4 mr-2" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
