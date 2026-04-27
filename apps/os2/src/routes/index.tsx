import { Link, createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { Button } from "@iterate-com/ui/components/button";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { getProjectByCustomHostname, getProjectBySlug } from "~/db/queries/.generated/index.ts";
import {
  normalizeRequestHostname,
  resolveProjectSlugFromHostname,
} from "~/lib/project-host-routing.ts";

type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

type ProjectRow = {
  id: string;
  slug: string;
  custom_hostname?: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
};

function toProject(row: ProjectRow) {
  return {
    id: row.id,
    slug: row.slug,
    customHostname: row.custom_hostname ?? null,
    metadata: JSON.parse(row.metadata) as Record<string, JsonValue>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const getHostProject = createServerFn({ method: "GET" }).handler(async ({ context }) => {
  const request = context.rawRequest ?? getRequest();
  const hostname = normalizeRequestHostname(new URL(request.url).hostname);
  const slug = resolveProjectSlugFromHostname(hostname, context.projectHostnameBases);

  if (!slug) {
    const customHostRow = await getProjectByCustomHostname(context.db, {
      customHostname: hostname,
    });
    if (customHostRow) return { kind: "project" as const, project: toProject(customHostRow) };

    return { kind: "control" as const };
  }

  const row = await getProjectBySlug(context.db, { slug });
  if (!row) return { kind: "missing" as const, slug };

  return { kind: "project" as const, project: toProject(row) };
});

export const Route = createFileRoute("/")({
  loader: async () => {
    const hostProject = await getHostProject();
    if (hostProject.kind === "control") {
      throw redirect({ to: "/debug", replace: true });
    }
    if (hostProject.kind === "missing") {
      throw notFound();
    }

    return hostProject.project;
  },
  component: ProjectHostPage,
});

function ProjectHostPage() {
  const project = Route.useLoaderData();

  return (
    <section className="min-h-svh bg-background p-4">
      <div className="mx-auto flex max-w-md flex-col gap-4">
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase text-muted-foreground">Project</p>
          <h2 className="text-sm font-semibold">{project.slug}</h2>
          <p className="text-sm text-muted-foreground">
            Resolved from this hostname and loaded from the projects table.
          </p>
        </div>

        <div className="space-y-3 rounded-lg border bg-card p-4">
          <div className="space-y-1">
            <p className="text-xs uppercase text-muted-foreground">ID</p>
            <Identifier value={project.id} />
          </div>
          <div className="space-y-1">
            <p className="text-xs uppercase text-muted-foreground">Slug</p>
            <p className="font-medium">{project.slug}</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs uppercase text-muted-foreground">Custom hostname</p>
            <p className="font-medium">{project.customHostname ?? "None"}</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs uppercase text-muted-foreground">Metadata</p>
            <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
              {JSON.stringify(project.metadata, null, 2)}
            </pre>
          </div>
          <div className="space-y-1">
            <p className="text-xs uppercase text-muted-foreground">Created</p>
            <p className="text-sm text-muted-foreground">{project.createdAt}</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs uppercase text-muted-foreground">Updated</p>
            <p className="text-sm text-muted-foreground">{project.updatedAt}</p>
          </div>
        </div>

        <Button
          size="sm"
          variant="outline"
          nativeButton={false}
          render={<Link to="/projects/$projectId" params={{ projectId: project.id }} />}
        >
          Open in OS
        </Button>
      </div>
    </section>
  );
}
