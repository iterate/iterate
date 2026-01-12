import { Link, useLocation } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";

import { Separator } from "./ui/separator.tsx";
import { SidebarTrigger } from "./ui/sidebar.tsx";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "./ui/breadcrumb.tsx";
import { OrgBreadcrumbDropdown, ProjectBreadcrumbDropdown } from "./breadcrumb-dropdown.tsx";

interface Organization {
  id: string;
  name: string;
  slug: string;
}

interface Project {
  id: string;
  name: string;
  slug: string;
}

interface AppHeaderProps {
  orgName?: string;
  projectName?: string;
  /** Organization slug from route params (type-safe, passed from parent) */
  organizationSlug?: string;
  /** Project slug from route params (type-safe, passed from parent) */
  projectSlug?: string;
  organizations?: Organization[];
  projects?: Project[];
}

// Map route segments to human-readable page names
const PAGE_NAMES: Record<string, string> = {
  connectors: "Connectors",
  agents: "Agents",
  machines: "Machines",
  repo: "Repo",
  "access-tokens": "Access Tokens",
  "env-vars": "Env Vars",
  settings: "Settings",
  team: "Team",
  "new-project": "New Project",
};

export function AppHeader({
  orgName,
  projectName,
  organizationSlug,
  projectSlug,
  organizations = [],
  projects = [],
}: AppHeaderProps) {
  const location = useLocation();

  // Determine current page from pathname
  const pathParts = location.pathname.split("/").filter(Boolean);
  const lastPart = pathParts[pathParts.length - 1];

  // Check if we're on a project sub-page (not the project home)
  const isProjectRoute = Boolean(projectSlug);
  const isProjectHome =
    isProjectRoute && (lastPart === projectSlug || location.pathname.endsWith(`/${projectSlug}/`));
  const isOrgRoute = Boolean(organizationSlug) && !isProjectRoute;
  const isOrgHome =
    isOrgRoute &&
    (lastPart === organizationSlug || location.pathname.endsWith(`/${organizationSlug}/`));

  // Get the current page name
  const currentPageName = PAGE_NAMES[lastPart] || null;

  // Find current org/project IDs for aria-current
  const currentOrgId = organizations.find((o) => o.slug === organizationSlug)?.id ?? "";
  const currentProjectId = projects.find((p) => p.slug === projectSlug)?.id ?? "";

  // Determine display name for mobile
  const mobileDisplayName = currentPageName || projectName || orgName || "Home";

  return (
    <header
      aria-label="Site header"
      className="flex h-16 shrink-0 items-center gap-2 border-b px-4 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12"
    >
      <div className="flex items-center gap-2">
        <SidebarTrigger className="-ml-1" aria-label="Toggle sidebar" />
        <Separator orientation="vertical" className="mr-2 hidden h-4 md:block" />

        {/* Mobile navigation - back button and current location */}
        <div className="flex items-center gap-2 md:hidden">
          {(organizationSlug || projectSlug) && (
            <Link
              to={projectSlug && organizationSlug ? "/orgs/$organizationSlug" : "/"}
              params={projectSlug && organizationSlug ? { organizationSlug } : undefined}
              className="flex items-center text-muted-foreground hover:text-foreground transition-colors rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Go back"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </Link>
          )}
          <span className="text-sm font-medium truncate max-w-[200px]">{mobileDisplayName}</span>
        </div>

        {/* Desktop breadcrumbs */}
        <Breadcrumb className="hidden md:flex">
          <BreadcrumbList>
            {/* Root: iterate */}
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to="/">iterate</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>

            {/* Organization level with dropdown */}
            {organizationSlug && (
              <>
                <BreadcrumbSeparator />
                {organizations.length > 0 ? (
                  <OrgBreadcrumbDropdown
                    currentName={orgName || organizationSlug}
                    currentId={currentOrgId}
                    items={organizations}
                    isCurrentPage={isOrgHome && !currentPageName}
                  />
                ) : (
                  <BreadcrumbItem>
                    {isOrgHome && !currentPageName ? (
                      <BreadcrumbPage>{orgName || organizationSlug}</BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink asChild>
                        <Link to="/orgs/$organizationSlug" params={{ organizationSlug }}>
                          {orgName || organizationSlug}
                        </Link>
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                )}
              </>
            )}

            {/* Org-level page (settings, team, new-project) */}
            {isOrgRoute && currentPageName && (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>{currentPageName}</BreadcrumbPage>
                </BreadcrumbItem>
              </>
            )}

            {/* Project level with dropdown */}
            {projectSlug && organizationSlug && (
              <>
                <BreadcrumbSeparator />
                {projects.length > 0 ? (
                  <ProjectBreadcrumbDropdown
                    currentName={projectName || projectSlug}
                    currentId={currentProjectId}
                    organizationSlug={organizationSlug}
                    items={projects}
                    isCurrentPage={isProjectHome && !currentPageName}
                  />
                ) : (
                  <BreadcrumbItem>
                    {isProjectHome && !currentPageName ? (
                      <BreadcrumbPage>{projectName || projectSlug}</BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink asChild>
                        <Link
                          to="/orgs/$organizationSlug/projects/$projectSlug"
                          params={{ organizationSlug, projectSlug }}
                        >
                          {projectName || projectSlug}
                        </Link>
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                )}
              </>
            )}

            {/* Project-level page (machines, agents, etc.) */}
            {isProjectRoute && currentPageName && (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>{currentPageName}</BreadcrumbPage>
                </BreadcrumbItem>
              </>
            )}
          </BreadcrumbList>
        </Breadcrumb>
      </div>
    </header>
  );
}
