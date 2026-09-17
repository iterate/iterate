// /projects/<project>/ — the overview: where the project answers, and a card per section, the map
// the dash fills in over time.
import { createFileRoute, getRouteApi, Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { Badge } from "@iterate-com/ui/components/badge";
import { buttonVariants } from "@iterate-com/ui/components/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@iterate-com/ui/components/card";
import { PROJECT_SECTIONS } from "../../../../sections.ts";

const shell = getRouteApi("/_auth");

export const Route = createFileRoute("/_auth/projects/$projectId/")({
  component: ProjectOverview,
});

function ProjectOverview() {
  const { project } = Route.useRouteContext();
  const { orgs } = shell.useLoaderData();
  const { info } = shell.useRouteContext();
  const org = orgs.find((candidate) => candidate.id === project.orgId);
  const origin = new URL(info.platformOrigin);
  const host = info.projectHostnameBase
    ? `${origin.protocol}//${project.id}.${info.projectHostnameBase}${origin.port ? `:${origin.port}` : ""}/`
    : null;
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-4 md:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <h1 className="font-mono text-2xl font-semibold tracking-tight">{project.id}</h1>
            {project.role ? <Badge variant="secondary">{project.role}</Badge> : null}
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
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Sections
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {PROJECT_SECTIONS.map((section) => (
            <li key={section.id}>
              <Card size="sm" className="relative h-full transition-colors hover:bg-accent/50">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <section.icon className="size-4 text-muted-foreground" />
                    <Link
                      to="/projects/$projectId/$section"
                      params={{ projectId: project.id, section: section.id }}
                      className="after:absolute after:inset-0"
                    >
                      {section.label}
                    </Link>
                  </CardTitle>
                  <CardDescription>{section.blurb}</CardDescription>
                </CardHeader>
              </Card>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
