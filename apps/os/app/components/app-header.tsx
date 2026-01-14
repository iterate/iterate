import { type ReactNode } from "react";
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
import {
  OrgBreadcrumbDropdown,
  ProjectBreadcrumbDropdown,
  MachineBreadcrumbDropdown,
} from "./breadcrumb-dropdown.tsx";

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

interface Machine {
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
  /** Organizations list for org dropdown */
  organizations?: Organization[];
  projects?: Project[];
  /** Machine list for machine dropdown */
  machines?: Machine[];
  /** Current machine ID when on machine detail page */
  currentMachineId?: string;
  /** Current machine name when on machine detail page */
  currentMachineName?: string;
  /** Header actions slot content from child pages */
  actions?: ReactNode;
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
  machines = [],
  currentMachineId,
  currentMachineName,
  actions,
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

  // Check if we're on a machine detail page: /orgs/{org}/projects/{proj}/machines/{machineId}
  const isMachineDetailRoute =
    isProjectRoute && pathParts[4] === "machines" && Boolean(pathParts[5]);

  // Get the current page name (only if we're on a sub-page, not a home page)
  // This prevents slugs matching PAGE_NAMES keys from being treated as sub-pages
  // Machine detail route should not show as "machine" page - it shows Machines > [machine dropdown]
  const currentPageName =
    !isProjectHome && !isOrgHome && !isMachineDetailRoute ? (PAGE_NAMES[lastPart] ?? null) : null;

  // Find current IDs for aria-current
  const currentOrgId = organizations.find((o) => o.slug === organizationSlug)?.id ?? "";
  const currentProjectId = projects.find((p) => p.slug === projectSlug)?.id ?? "";

  // Determine display name for mobile
  const mobileDisplayName =
    currentMachineName || currentPageName || projectName || orgName || "Home";

  return (
    <header
      aria-label="Site header"
      className="flex h-16 shrink-0 items-center border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12"
    >
      <div className="flex w-full max-w-3xl items-center justify-between gap-2 px-4">
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
              {/* Organization level with dropdown */}
              {organizationSlug && (
                <>
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
                      currentSlug={projectSlug}
                      organizationSlug={organizationSlug}
                      items={projects}
                      isCurrentPage={isProjectHome && !currentPageName}
                    />
                  ) : (
                    <BreadcrumbItem data-project={projectSlug}>
                      {isProjectHome && !currentPageName ? (
                        <BreadcrumbPage>Project: {projectName || projectSlug}</BreadcrumbPage>
                      ) : (
                        <BreadcrumbLink asChild>
                          <Link
                            to="/orgs/$organizationSlug/projects/$projectSlug"
                            params={{ organizationSlug, projectSlug }}
                          >
                            Project: {projectName || projectSlug}
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

              {/* Machine detail: straight to machine dropdown (no "Machines" link) */}
              {isMachineDetailRoute && organizationSlug && projectSlug && (
                <>
                  <BreadcrumbSeparator />
                  {machines.length > 0 && currentMachineId ? (
                    <MachineBreadcrumbDropdown
                      currentName={currentMachineName || currentMachineId}
                      currentId={currentMachineId}
                      organizationSlug={organizationSlug}
                      projectSlug={projectSlug}
                      items={machines}
                      isCurrentPage={true}
                    />
                  ) : (
                    <BreadcrumbItem>
                      <BreadcrumbPage>
                        Machine: {currentMachineName || currentMachineId || "Unknown"}
                      </BreadcrumbPage>
                    </BreadcrumbItem>
                  )}
                </>
              )}
            </BreadcrumbList>
          </Breadcrumb>
        </div>

        {/* Actions slot - pages can render buttons here via HeaderActions component */}
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
