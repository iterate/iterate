// /projects/<slug> — the project layout: the project resolved by its slug (its id works too) from
// the tree (components/organization-tree.tsx) when the shell has it open — a navigation within
// the shell — else from the session's catalog: a fresh page load, before the tree has loaded, or
// a session that lists rather than reads (a narrowed grant). One this sign-in lacks sends the
// browser to sign in again. Handed to every section below.
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { readOrganizationTree } from "../../../../components/organization-tree.tsx";

export const Route = createFileRoute("/_auth/projects/$slug")({
  beforeLoad: async ({ context, params }) => {
    const named = (candidate: { id: string; slug: string }) =>
      candidate.slug === params.slug || candidate.id === params.slug;
    const project =
      readOrganizationTree().projects.find(named) ??
      (await context.api.projects.list()).find(named);
    if (!project) return context.signInFor(params.slug);
    return { project: { id: project.id, slug: project.slug, orgId: project.orgId } };
  },
  // the title from the URL's own segment: `head` runs before `beforeLoad` has put the project on the
  // context, and a title that reads `match.context.project` throws and leaves the page blank (prd, #2783)
  head: ({ params }) => ({ meta: [{ title: `${params.slug} · Dash` }] }),
  component: Outlet,
});
