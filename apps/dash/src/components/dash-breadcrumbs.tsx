// The path in the shell's header: Projects › <organization> › <project>. Read from the route params,
// so every page under /projects gets it for free; the leading segments hide on narrow screens.
import { Link, useParams } from "@tanstack/react-router";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@iterate-com/ui/components/breadcrumb";
import type { Org, Project } from "../lib/projects.ts";

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
  const { projectId } = useParams({ strict: false });
  const project = projects.find((candidate) => candidate.id === projectId);
  const org = project ? orgs.find((candidate) => candidate.id === project.orgId) : undefined;
  const crumbs: { label: string; to?: string; hideOnMobile?: boolean }[] = projectId
    ? [
        { label: "Projects", to: "/projects", hideOnMobile: true },
        ...(org ? [{ label: org.name, hideOnMobile: true }] : []),
        { label: project?.slug || projectId },
      ]
    : [{ label: page || "Projects" }];
  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          const hidden = crumb.hideOnMobile && !last ? "hidden md:inline-flex" : "";
          return [
            <BreadcrumbItem key={`${crumb.label}-item`} className={hidden}>
              {last ? (
                <BreadcrumbPage className={project ? "font-mono" : undefined}>
                  {crumb.label}
                </BreadcrumbPage>
              ) : crumb.to ? (
                <BreadcrumbLink render={<Link to={crumb.to} />}>{crumb.label}</BreadcrumbLink>
              ) : (
                <span>{crumb.label}</span>
              )}
            </BreadcrumbItem>,
            last ? null : <BreadcrumbSeparator key={`${crumb.label}-sep`} className={hidden} />,
          ];
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
