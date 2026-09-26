// The path in the shell's header: Projects › <organization> › <project>, then the project's page
// when it names itself (› Contexts, › Integrations), or Organizations › <organization>. An
// organization shows once its record has named it, never as its id. The project is the one its route resolved (the shell hands it down); the
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
  /** the label a page names itself with (`staticData: { page }`): Sessions, or a project's Contexts */
  page?: string;
}) {
  const { slug, orgId } = useParams({ strict: false });
  const tree = useOrganizationTree();
  // an organization's name once its record has said it: until then the tree holds its id, which
  // is no name to show
  const org = tree.organizations.find(
    (candidate) =>
      candidate.id === (project ? project.orgId : orgId) && candidate.status === "live",
  );
  const projectSlug = project?.slug || slug;
  const crumbs: { label: string; to?: string; hideOnMobile?: boolean; mono?: boolean }[] = slug
    ? [
        { label: "Projects", to: "/projects", hideOnMobile: true },
        ...(org ? [{ label: org.name, hideOnMobile: true }] : []),
        page
          ? { label: projectSlug!, to: `/projects/${projectSlug!}`, hideOnMobile: true, mono: true }
          : { label: projectSlug!, mono: true },
        ...(page ? [{ label: page }] : []),
      ]
    : orgId
      ? [
          { label: "Organizations", to: "/organizations", hideOnMobile: true },
          { label: org?.name || "Organization" },
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
                <BreadcrumbPage className={crumb.mono ? "font-mono" : undefined}>
                  {crumb.label}
                </BreadcrumbPage>
              ) : crumb.to ? (
                <BreadcrumbLink
                  className={crumb.mono ? "font-mono" : undefined}
                  render={<Link to={crumb.to} />}
                >
                  {crumb.label}
                </BreadcrumbLink>
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
