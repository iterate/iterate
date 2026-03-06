import { Link, useMatchRoute } from "@tanstack/react-router";
import { Box, CreditCard, FolderOpen, Plus, Settings, Users } from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "./ui/sidebar.tsx";

interface Project {
  id: string;
  name: string;
  slug: string;
}

interface OrgSidebarNavProps {
  orgSlug: string;
  projects?: Project[];
}

export function OrgSidebarNav({ orgSlug, projects }: OrgSidebarNavProps) {
  const matchRoute = useMatchRoute();
  const { isMobile } = useSidebar();

  const isOrgSettingsActive = Boolean(
    matchRoute({
      to: "/orgs/$organizationSlug/settings",
      params: { organizationSlug: orgSlug },
    }),
  );
  const isTeamActive = Boolean(
    matchRoute({
      to: "/orgs/$organizationSlug/team",
      params: { organizationSlug: orgSlug },
    }),
  );
  const isBillingActive = Boolean(
    matchRoute({
      to: "/orgs/$organizationSlug/billing",
      params: { organizationSlug: orgSlug },
    }),
  );

  return (
    <>
      <SidebarGroup data-group="organization">
        <SidebarGroupLabel>Organization</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {/* All projects - visible on mobile only */}
            {isMobile && (
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <Link to="/orgs/$organizationSlug" params={{ organizationSlug: orgSlug }}>
                    <FolderOpen className="h-4 w-4" />
                    <span>All projects</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
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
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={isBillingActive}>
                <Link to="/orgs/$organizationSlug/billing" params={{ organizationSlug: orgSlug }}>
                  <CreditCard className="h-4 w-4" />
                  <span>Billing</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      {/* Projects section - shown when projects are passed (org-level view), desktop only */}
      {projects && !isMobile && (
        <SidebarGroup>
          <SidebarGroupLabel>Projects</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {projects.map((project) => {
                const isActive = Boolean(
                  matchRoute({
                    to: "/proj/$projectSlug",
                    params: { projectSlug: project.slug },
                    fuzzy: true,
                  }),
                );
                return (
                  <SidebarMenuItem key={project.id}>
                    <SidebarMenuButton asChild isActive={isActive}>
                      <Link to="/proj/$projectSlug" params={{ projectSlug: project.slug }}>
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
                    <span>New project</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      )}
    </>
  );
}
