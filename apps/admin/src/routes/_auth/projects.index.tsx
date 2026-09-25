// /projects — every project this session reaches (for an admin, every project on the platform),
// each a link into its contexts.
import { createFileRoute, getRouteApi, Link } from "@tanstack/react-router";

const shell = getRouteApi("/_auth");

export const Route = createFileRoute("/_auth/projects/")({
  head: () => ({ meta: [{ title: "Projects · Admin" }] }),
  component: Projects,
});

function Projects() {
  const { projects } = shell.useLoaderData();
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 md:p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className="py-1 font-medium">Slug</th>
            <th className="py-1 font-medium">Id</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((project) => (
            <tr key={project.id} className="border-t">
              <td className="py-1.5">
                <Link
                  to="/projects/$slug/$"
                  params={{ slug: project.slug, _splat: "" }}
                  className="hover:underline"
                >
                  {project.slug}
                </Link>
              </td>
              <td className="py-1.5 font-mono text-xs text-muted-foreground">{project.id}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
