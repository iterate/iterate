// /projects/<project>/ — the overview: the project, its role, its site. The frame the project's
// own pages fill in over time.
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { Badge } from "@iterate-com/ui/components/badge";
import { buttonVariants } from "@iterate-com/ui/components/button";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { cn } from "@iterate-com/ui/lib/utils";
import { projectHostOf } from "../../../_auth.tsx";

const shell = getRouteApi("/_auth");

export const Route = createFileRoute("/_auth/projects/$slug/")({
  component: ProjectOverview,
});

function ProjectOverview() {
  const { project } = Route.useRouteContext();
  const { orgs } = shell.useLoaderData();
  const { info } = shell.useRouteContext();
  const org = orgs.find((candidate) => candidate.id === project.orgId);
  const host = projectHostOf(info, project.slug);
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-4 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <h1 className="font-mono text-2xl font-semibold tracking-tight">{project.slug}</h1>
          {org?.role ? <Badge variant="secondary">{org.role}</Badge> : null}
        </div>
        {host ? (
          <a
            href={host}
            target="_blank"
            rel="noreferrer"
            className={cn(buttonVariants({ variant: "outline" }))}
          >
            Open {new URL(host).host}
            <ArrowUpRight />
          </a>
        ) : null}
      </div>
      {/* the ids, copyable: the project's, and its organization's beside the name */}
      <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">Project id</dt>
        <dd>
          <Identifier value={project.id} />
        </dd>
        <dt className="text-muted-foreground">Organization</dt>
        <dd className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {org?.name ? <span>{org.name}</span> : null}
          <Identifier value={project.orgId} />
        </dd>
      </dl>
    </div>
  );
}
