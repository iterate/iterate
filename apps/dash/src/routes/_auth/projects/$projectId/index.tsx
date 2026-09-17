// /projects/<project>/ — the overview: which organization it belongs to, where it answers, and
// the apps that work on it today. The frame the project's own pages fill in over time.
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { Badge } from "@iterate-com/ui/components/badge";
import { buttonVariants } from "@iterate-com/ui/components/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@iterate-com/ui/components/card";
import { APPS } from "../../../../apps.ts";
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
  const host = projectHostOf(info, project.id);
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-4 md:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <h1 className="font-mono text-2xl font-semibold tracking-tight">{project.id}</h1>
            {org?.role ? <Badge variant="secondary">{org.role}</Badge> : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {org ? `In ${org.name}. ` : ""}
            {host
              ? "Its config worker answers on its own host."
              : "No project host on this deployment."}
          </p>
        </div>
        {host ? (
          <a
            href={host}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: "outline" })}
          >
            Open {new URL(host).host}
            <ArrowUpRight />
          </a>
        ) : null}
      </div>
      <section className="flex flex-col gap-3">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Apps</h2>
        <ul className="grid gap-3 sm:grid-cols-3">
          {APPS.map((app) => (
            <li key={app.url}>
              <Card size="sm" className="relative h-full transition-colors hover:bg-accent/50">
                <CardHeader>
                  <CardTitle className="flex items-center gap-1 text-sm">
                    <a
                      href={app.url}
                      target="_blank"
                      rel="noreferrer"
                      className="after:absolute after:inset-0"
                    >
                      {app.name}
                    </a>
                    <ArrowUpRight className="size-3.5 text-muted-foreground" />
                  </CardTitle>
                  <CardDescription>{app.blurb}</CardDescription>
                </CardHeader>
              </Card>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
