// /projects/<project>/ — the overview: the project, its role, its site. The frame the project's
// own pages fill in over time.
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { Badge } from "@iterate-com/ui/components/badge";
import { buttonVariants } from "@iterate-com/ui/components/button";
import { cn } from "@iterate-com/ui/lib/utils";
import { projectHostOf } from "../../../_auth.tsx";

const shell = getRouteApi("/_auth");

export const Route = createFileRoute("/_auth/projects/$projectId/")({
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
    </div>
  );
}
