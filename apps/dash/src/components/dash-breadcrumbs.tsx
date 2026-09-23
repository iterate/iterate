// The path in the shell's header: Projects › <organization> › <project>, or Organizations ›
// <organization>. The project is the one its route resolved (the shell hands it down); the
// organization's name comes from the tree (components/organization-tree.tsx, live); the leading
// segments hide on narrow screens.
import { Link, useParams } from "@tanstack/react-router";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@iterate-com/ui/components/breadcrumb";
import { useOrganizationTree } from "./organization-tree.tsx";

export function DashBreadcrumbs({
  project,
  page,
}: {
  /** inside a project: the one the URL names */
  project: { id: string; slug: string; orgId: string } | null;
  /** the label of a page outside /projects and /organizations (Sessions) */
  page?: string;
}) {
  const { slug, orgId } = useParams({ strict: false });
  const tree = useOrganizationTree();
  const org = tree.organizations.find(
    (candidate) => candidate.id === (project ? project.orgId : orgId),
  );
  const crumbs: { label: string; to?: string; hideOnMobile?: boolean }[] = slug
    ? [
        { label: "Projects", to: "/projects", hideOnMobile: true },
        ...(org ? [{ label: org.name, hideOnMobile: true }] : []),
        { label: project?.slug || slug },
      ]
    : orgId
      ? [
          { label: "Organizations", to: "/organizations", hideOnMobile: true },
          { label: org?.name || orgId },
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
