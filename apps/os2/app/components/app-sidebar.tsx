import { Link, useLocation, useParams } from "@tanstack/react-router";
import { useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronsUpDown,
  LogOut,
  Server,
  Users,
  Puzzle,
  Settings,
  Plus,
  Building2,
  FolderKanban,
} from "lucide-react";
import { authClient } from "../lib/auth-client.ts";
import { useTRPC } from "../lib/trpc.ts";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
} from "./ui/sidebar.tsx";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";

interface AppSidebarProps {
  user: {
    id: string;
    name: string;
    email: string;
    image?: string | null;
  };
}

export function AppSidebar({ user }: AppSidebarProps) {
  const location = useLocation();
  const params = useParams({ strict: false });
  const organizationSlug = params.organizationSlug as string | undefined;
  const projectSlug = params.projectSlug as string | undefined;
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data: orgsWithProjects } = useSuspenseQuery(
    trpc.user.organizationsWithProjects.queryOptions(),
  );

  const currentOrg = orgsWithProjects.find((m) => m.organization.slug === organizationSlug);
  const currentProject = currentOrg?.organization.projects.find((p) => p.slug === projectSlug);

  const handleLogout = async () => {
    await authClient.signOut({
      fetchOptions: {
        onSuccess: () => {
          queryClient.clear();
          window.location.href = "/login";
        },
      },
    });
  };

  const getInitials = (name: string) => {
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  const isPathActive = (path: string) => {
    return location.pathname === path || location.pathname === `${path}/`;
  };

  return (
    <Sidebar className="border-r">
      <SidebarHeader>
        <OrgProjectSwitcher
          orgsWithProjects={orgsWithProjects}
          currentOrg={currentOrg?.organization}
          currentProject={currentProject}
        />
      </SidebarHeader>

      <SidebarContent>
        {currentOrg && currentProject && (
          <SidebarGroup>
            <SidebarGroupLabel>
              <FolderKanban className="size-3 mr-1" />
              {currentProject.name}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={isPathActive(`/${organizationSlug}/${projectSlug}`)}
                  >
                    <Link
                      to="/$organizationSlug/$projectSlug"
                      params={{ organizationSlug: organizationSlug!, projectSlug: projectSlug! }}
                    >
                      <Server className="size-4" />
                      <span>Machines</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {currentOrg && (
          <SidebarGroup>
            <SidebarGroupLabel>Organization</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={isPathActive(`/${organizationSlug}/team`)}>
                    <Link
                      to="/$organizationSlug/team"
                      params={{ organizationSlug: organizationSlug! }}
                    >
                      <Users className="size-4" />
                      <span>Team</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={isPathActive(`/${organizationSlug}/connectors`)}
                  >
                    <Link
                      to="/$organizationSlug/connectors"
                      params={{ organizationSlug: organizationSlug! }}
                    >
                      <Puzzle className="size-4" />
                      <span>Connectors</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={isPathActive(`/${organizationSlug}/settings`)}
                  >
                    <Link
                      to="/$organizationSlug/settings"
                      params={{ organizationSlug: organizationSlug! }}
                    >
                      <Settings className="size-4" />
                      <span>Settings</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                >
                  <Avatar className="h-8 w-8 rounded-lg">
                    <AvatarImage src={user.image ?? undefined} alt={user.name} />
                    <AvatarFallback className="rounded-lg">{getInitials(user.name)}</AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{user.name}</span>
                    <span className="truncate text-xs">{user.email}</span>
                  </div>
                  <ChevronsUpDown className="ml-auto size-4" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-56" side="top" align="start">
                <DropdownMenuItem onClick={handleLogout}>
                  <LogOut className="mr-2 h-4 w-4" />
                  <span>Log out</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

interface OrgProjectSwitcherProps {
  orgsWithProjects: Array<{
    organization: {
      id: string;
      name: string;
      slug: string;
      projects: Array<{
        id: string;
        name: string;
        slug: string;
      }>;
    };
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
}

function OrgProjectSwitcher({
  orgsWithProjects,
  currentOrg,
  currentProject,
}: OrgProjectSwitcherProps) {
  if (orgsWithProjects.length === 0) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg" asChild>
            <Link to="/new-organization">
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg border border-dashed">
                <Plus className="size-4" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">Create Organization</span>
                <span className="truncate text-xs text-muted-foreground">Get started</span>
              </div>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <Building2 className="size-4" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">
                  {currentOrg?.name || "Select Organization"}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {currentProject?.name || "Select project"}
                </span>
              </div>
              <ChevronsUpDown className="ml-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            align="start"
            side="bottom"
            sideOffset={4}
          >
            {orgsWithProjects.map(({ organization: org }) => (
              <div key={org.id}>
                <DropdownMenuItem asChild className="gap-2 p-2">
                  <Link to="/$organizationSlug" params={{ organizationSlug: org.slug }}>
                    <div className="flex size-6 items-center justify-center rounded-sm border">
                      <span className="text-xs font-semibold">
                        {org.name.charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <div className="flex flex-col">
                      <span className="font-medium">{org.name}</span>
                    </div>
                  </Link>
                </DropdownMenuItem>
                {org.projects.length > 0 && (
                  <div className="ml-4 border-l pl-2">
                    {org.projects.map((project) => (
                      <DropdownMenuItem key={project.id} asChild className="gap-2 p-2">
                        <Link
                          to="/$organizationSlug/$projectSlug"
                          params={{ organizationSlug: org.slug, projectSlug: project.slug }}
                        >
                          <FolderKanban className="size-4 text-muted-foreground" />
                          <span className="text-sm">{project.name}</span>
                        </Link>
                      </DropdownMenuItem>
                    ))}
                  </div>
                )}
              </div>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild className="gap-2 p-2">
              <Link to="/new-organization">
                <div className="flex size-6 items-center justify-center rounded-md border border-dashed">
                  <Plus className="size-4" />
                </div>
                <div className="font-medium text-muted-foreground">Add organization</div>
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
