// The REPL always runs against a project now (runs execute as scope scripts
// server-side), so the old session-level REPL page is a minimal chooser:
// pick a project, land in its REPL.

import { Link, createFileRoute } from "@tanstack/react-router";
import { SquareTerminal } from "lucide-react";
import { useIterateSessionQuery } from "iterate/sdk/itx/react";
import { projectsListStaleTime } from "~/lib/projects-query.ts";

export const Route = createFileRoute("/_app/itx-repl")({
  staticData: {
    breadcrumb: "Repl",
  },
  ssr: false,
  component: ItxReplChooserPage,
});

function ItxReplChooserPage() {
  const { data, isPending } = useIterateSessionQuery({
    key: ["projects"],
    query: (session) => session.projects.list(),
    staleTime: projectsListStaleTime,
  });
  const projects = (data || []).filter(
    (project) => project.deploymentStatus !== "missing" && project.deploymentStatus !== "failed",
  );

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-sm font-medium">Pick a project</h1>
        <p className="text-sm text-muted-foreground">
          The REPL runs scripts inside a project — durable, typechecked, with your prior results in
          scope.
        </p>
      </div>
      {isPending ? (
        <p className="text-sm text-muted-foreground" data-spinner="true">
          Loading projects...
        </p>
      ) : projects.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No projects yet —{" "}
          <Link className="underline" to="/projects">
            create one
          </Link>{" "}
          first.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {projects.map((project) => (
            <li key={project.id}>
              <Link
                className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted"
                params={{ projectSlug: project.slug }}
                to="/projects/$projectSlug/repl"
              >
                <SquareTerminal className="size-4 text-muted-foreground" />
                <span className="truncate">{project.slug}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
