import { Link, useLocation } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";

import { Separator } from "./ui/separator.tsx";
import { SidebarTrigger } from "./ui/sidebar.tsx";
import { HEADER_ACTIONS_ID } from "./header-actions-constants.ts";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "./ui/breadcrumb.tsx";
import { ProjectBreadcrumbDropdown } from "./breadcrumb-dropdown.tsx";

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
  projects = [],
}: AppHeaderProps) {
  const location = useLocation();

  // Determine current page from pathname
  const pathParts = location.pathname.split("/").filter(Boolean);
  const lastPart = pathParts[pathParts.length - 1];

  // Check if we're on a home page (not a sub-page)
  // Use path structure to avoid edge case where slug matches a PAGE_NAMES key
  // Org home: /orgs/{orgSlug} → 2 parts
  // Project home: /orgs/{orgSlug}/projects/{projectSlug} → 4 parts
  const isProjectRoute = Boolean(projectSlug);
  const isProjectHome = isProjectRoute && pathParts.length === 4;
  const isOrgRoute = Boolean(organizationSlug) && !isProjectRoute;
  const isOrgHome = isOrgRoute && pathParts.length === 2;

  // Get the current page name (only if we're on a sub-page, not a home page)
  // This prevents slugs matching PAGE_NAMES keys from being treated as sub-pages
  const currentPageName = !isProjectHome && !isOrgHome ? (PAGE_NAMES[lastPart] ?? null) : null;

  // Find current project ID for aria-current
  const currentProjectId = projects.find((p) => p.slug === projectSlug)?.id ?? "";

  // Determine display name for mobile
  const mobileDisplayName = currentPageName || projectName || orgName || "Home";

  return (
    <header
      data-component="AppHeader"
      aria-label="Site header"
      className="flex h-16 shrink-0 items-center border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12"
    >
      <div className="flex w-full max-w-md items-center justify-between gap-2 px-4">
        <div className="flex items-center gap-2">
          <SidebarTrigger className="-ml-1" aria-label="Toggle sidebar" />
          <Separator orientation="vertical" className="mr-2 hidden h-4 md:block" />

          {/* Mobile navigation - back button and current location */}
          <div className="flex items-center gap-2 md:hidden">
            {(organizationSlug || projectSlug) && (
              <Link
                to={
                  projectSlug && organizationSlug
                    ? "/orgs/$organizationSlug"
                    : organizationSlug && !isOrgHome
                      ? "/orgs/$organizationSlug"
                      : "/"
                }
                params={
                  (projectSlug && organizationSlug) || (organizationSlug && !isOrgHome)
                    ? { organizationSlug }
                    : undefined
                }
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
              {/* Organization level - simple link, no dropdown */}
              {organizationSlug && (
                <BreadcrumbItem>
                  {isOrgHome && !currentPageName ? (
                    <BreadcrumbPage data-organization={organizationSlug}>
                      {orgName || organizationSlug}
                    </BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink asChild>
                      <Link to="/orgs/$organizationSlug" params={{ organizationSlug }}>
                        {orgName || organizationSlug}
                      </Link>
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
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
                      currentSlug={projectSlug}
                      organizationSlug={organizationSlug}
                      items={projects}
                      isCurrentPage={isProjectHome && !currentPageName}
                    />
                  ) : (
                    <BreadcrumbItem data-project={projectSlug}>
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

        {/* Actions slot - pages can render buttons here via HeaderActions component */}
        <div id={HEADER_ACTIONS_ID} className="flex items-center gap-2" />
      </div>
    </header>
  );
}
