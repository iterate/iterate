// Where a signed-in browser lands (the worker sends `/` here, the login door's `next` too), the way
// the root decides: exactly one project → that project; otherwise the projects list — read off the
// tree (components/organization-tree.tsx) once it has loaded. The list itself never redirects — the
// switcher's "All projects" must not hijack a single-project person back.
import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { DefaultPendingComponent } from "@iterate-com/ui/components/route-defaults";
import { useOrganizationTree } from "../../components/organization-tree.tsx";

export const Route = createFileRoute("/_auth/home")({
  component: Home,
});

function Home() {
  const tree = useOrganizationTree();
  const navigate = useNavigate();
  // an organization whose live state failed lists no projects: never read its absence as "one"
  const complete = tree.loaded && tree.organizations.every((org) => org.status === "live");
  const only = complete && tree.projects.length === 1 ? tree.projects[0]!.slug : null;
  useEffect(() => {
    if (!tree.loaded) return;
    void navigate(
      only
        ? { to: "/projects/$slug", params: { slug: only }, replace: true }
        : { to: "/projects", replace: true },
    );
  }, [tree.loaded, only, navigate]);
  return <DefaultPendingComponent />;
}
