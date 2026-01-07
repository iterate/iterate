import { Link, useLocation } from "@tanstack/react-router";
import { Building2, ChevronDown, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar.tsx";

interface Project {
  id: string;
  name: string;
  slug: string;
}

interface Organization {
  id: string;
  name: string;
  slug: string;
  projects: Project[];
}

interface OrgProjectSwitcherProps {
  organizations: Organization[];
  currentOrg: Organization;
  currentProject?: Project;
}

export function OrgProjectSwitcher({
  organizations,
  currentOrg,
  currentProject,
}: OrgProjectSwitcherProps) {
  const location = useLocation();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg">
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <Building2 className="h-4 w-4 shrink-0" />
                  <span className="truncate font-medium">{currentOrg.name}</span>
                </div>
                {currentProject && (
                  <span className="truncate pl-6 text-xs text-muted-foreground">
                    {currentProject.name}
                  </span>
                )}
              </div>
              <ChevronDown className="ml-auto h-4 w-4 shrink-0" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-64" align="start">
            {organizations.map((org) => {
              const isCurrentOrg = org.id === currentOrg.id;
              return (
                <div key={org.id}>
                  <DropdownMenuItem asChild className={isCurrentOrg ? "font-medium" : ""}>
                    <Link
                      to="/orgs/$organizationSlug"
                      params={{ organizationSlug: org.slug }}
                    >
                      <Building2 className="mr-2 h-4 w-4" />
                      {org.name}
                    </Link>
                  </DropdownMenuItem>
                  {org.projects.map((project) => {
                    const isActiveProject =
                      isCurrentOrg &&
                      currentProject?.id === project.id &&
                      location.pathname.includes(`/projects/${project.slug}`);
                    return (
                      <DropdownMenuItem
                        key={project.id}
                        asChild
                        className={isActiveProject ? "bg-accent" : ""}
                      >
                        <Link
                          to="/orgs/$organizationSlug/projects/$projectSlug"
                          params={{ organizationSlug: org.slug, projectSlug: project.slug }}
                          className="pl-8"
                        >
                          {project.name}
                        </Link>
                      </DropdownMenuItem>
                    );
                  })}
                </div>
              );
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link to="/new-organization">
                <Plus className="mr-2 h-4 w-4" />
                New organization
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
