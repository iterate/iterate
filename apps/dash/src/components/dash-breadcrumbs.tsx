// The path in the shell's header: Projects › <organization> › <project> › <section>. Read from the
// route params, so every page under /projects gets it for free; the organization segment hides
// on narrow screens.
import { Link, useParams } from "@tanstack/react-router";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@iterate-com/ui/components/breadcrumb";
import { OVERVIEW, sectionById } from "../sections.ts";
import type { Org, Project } from "./dash-sidebar.tsx";

export function DashBreadcrumbs({
  orgs,
  projects,
  page,
}: {
  orgs: Org[];
  projects: Project[];
  /** the label of a page outside /projects (Sessions) */
  page?: string;
}) {
  const { projectId, section } = useParams({ strict: false });
  const project = projects.find((candidate) => candidate.id === projectId);
  const org = project ? orgs.find((candidate) => candidate.id === project.orgId) : undefined;
  const sectionLabel = section ? (sectionById(section)?.label ?? section) : null;
  const crumbs: {
    label: string;
    to?: string;
    params?: Record<string, string>;
    hideOnMobile?: boolean;
  }[] = projectId
    ? [
        { label: "Projects", to: "/projects", hideOnMobile: true },
        ...(org ? [{ label: org.name, hideOnMobile: true }] : []),
        {
          label: projectId,
          ...(sectionLabel ? { to: "/projects/$projectId", params: { projectId } } : {}),
        },
        ...(sectionLabel ? [{ label: sectionLabel }] : []),
      ]
    : [{ label: page ?? "Projects" }];
  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          const hidden = crumb.hideOnMobile && !last ? "hidden md:inline-flex" : "";
          return [
            <BreadcrumbItem key={`${crumb.label}-item`} className={hidden}>
              {last || !crumb.to ? (
                last ? (
                  <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                ) : (
                  <span className="text-muted-foreground">{crumb.label}</span>
                )
              ) : (
                <BreadcrumbLink render={<Link to={crumb.to} params={crumb.params} />}>
                  {crumb.label}
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>,
            last ? null : <BreadcrumbSeparator key={`${crumb.label}-sep`} className={hidden} />,
          ];
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

export const overviewLabel = OVERVIEW.label;
