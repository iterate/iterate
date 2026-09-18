// What the shell loads once for every page: the person's organizations and projects, as the
// session lists them, and the one grouping the switcher, the breadcrumbs and the projects page share.
export type Org = { id: string; name: string; role?: string; projects: number };
export type Project = { id: string; slug: string; orgId: string };

/** Projects grouped by organization, in the organizations' order; a project whose organization
 *  this grant does not list (a narrowed grant) sits under "Other". */
export function projectsByOrg(orgs: Org[], projects: Project[]) {
  const groups = orgs.map((org) => ({
    org,
    projects: projects.filter((project) => project.orgId === org.id),
  }));
  const known = new Set(orgs.map((org) => org.id));
  const other = projects.filter((project) => !known.has(project.orgId));
  if (other.length)
    groups.push({ org: { id: "", name: "Other", projects: other.length }, projects: other });
  return groups.filter((group) => group.projects.length);
}
