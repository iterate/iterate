import { Link, useLocation } from "@tanstack/react-router";
import { Box, Plus, Settings, User, Users } from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "./ui/sidebar.tsx";

interface Project {
  id: string;
  name: string;
  slug: string;
}

interface OrgSidebarNavProps {
  orgSlug: string;
  orgName: string;
  projects: Project[];
}

export function OrgSidebarNav({ orgSlug, orgName, projects }: OrgSidebarNavProps) {
  const location = useLocation();

  const isOrgSettingsActive = location.pathname === `/orgs/${orgSlug}/settings`;
  const isTeamActive = location.pathname === `/orgs/${orgSlug}/team`;
  const isUserSettingsActive = location.pathname === "/user/settings";

  return (
    <>
      <SidebarGroup>
        <SidebarGroupLabel className="h-auto min-h-8 flex-wrap gap-x-1">
          <span>Organization:</span>
          <span>{orgName}</span>
        </SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={isOrgSettingsActive}>
                <Link to="/orgs/$organizationSlug/settings" params={{ organizationSlug: orgSlug }}>
                  <Settings className="h-4 w-4" />
                  <span>Settings</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={isTeamActive}>
                <Link to="/orgs/$organizationSlug/team" params={{ organizationSlug: orgSlug }}>
                  <Users className="h-4 w-4" />
                  <span>Team</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarGroup>
        <SidebarGroupLabel>Projects</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {projects.map((project) => {
              const isProjectActive = location.pathname.startsWith(
                `/orgs/${orgSlug}/projects/${project.slug}`,
              );
              return (
                <SidebarMenuItem key={project.id}>
                  <SidebarMenuButton asChild isActive={isProjectActive}>
                    <Link
                      to="/orgs/$organizationSlug/projects/$projectSlug"
                      params={{ organizationSlug: orgSlug, projectSlug: project.slug }}
                    >
                      <Box className="h-4 w-4" />
                      <span>{project.name}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <Link
                  to="/orgs/$organizationSlug/new-project"
                  params={{ organizationSlug: orgSlug }}
                >
                  <Plus className="h-4 w-4" />
                  <span>Add project</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarGroup>
        <SidebarGroupLabel>User</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={isUserSettingsActive}>
                <Link to="/user/settings">
                  <User className="h-4 w-4" />
                  <span>Settings</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  );
}
