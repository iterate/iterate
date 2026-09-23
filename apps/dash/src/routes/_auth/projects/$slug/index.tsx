// /projects/<project>/ — the overview: the project, its role, its site — and, while the project's own
// creation runs, where it stands: the `project` facet's LIVE STATE on `/` (os-next src/project/),
// rendered as apps/os's creation checklist until `project/created` lands, or as the failure the
// processor reported. The frame the project's own pages fill in over time.
import { useEffect, useState } from "react";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { ArrowUpRight, CheckIcon, CircleXIcon, LoaderCircleIcon } from "lucide-react";
import { z } from "zod";
import type { AuthenticatedApp } from "iterate/next/app";
import { useLiveState } from "iterate/next/react";
import { Badge } from "@iterate-com/ui/components/badge";
import { buttonVariants } from "@iterate-com/ui/components/button";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { cn } from "@iterate-com/ui/lib/utils";
import { useOrganizationTree } from "../../../../components/organization-tree.tsx";
import { projectHostOf } from "../../../../lib/origins.ts";

const shell = getRouteApi("/_auth");

/** The project's root context as the page holds it: `api.projects.get(id)`, a capnweb stub. */
type ProjectContext = Awaited<ReturnType<AuthenticatedApp["api"]["projects"]["get"]>>;

/** The project facet's live state, the one field this page reads: where the project's own creation
 *  stands, as the offset of the event that says so (null for a project born before the saga existed). */
const ProjectLive = z.looseObject({
  creation: z
    .object({ status: z.enum(["requested", "created", "failed"]), offset: z.number() })
    .nullable(),
  /** the catalog's repos, by path: the seeded config repo is the saga's first visible step */
  repos: z.record(z.string(), z.unknown()),
});

export const Route = createFileRoute("/_auth/projects/$slug/")({
  component: ProjectOverview,
});

/** The project's root context, held for the page's life and disposed on unmount. */
function useProjectContext(api: AuthenticatedApp["api"], projectId: string) {
  const [context, setContext] = useState<ProjectContext>();
  useEffect(() => {
    let disposed = false;
    let held: ProjectContext | undefined;
    (async () => {
      const stub = await api.projects.get(projectId);
      // an unmount mid-await comes before the handle the await returns
      if (disposed) {
        stub[Symbol.dispose]();
        return;
      }
      held = stub;
      // A capnweb stub is a callable proxy: handed to a state setter directly, React would take it
      // for an updater and CALL it (an empty method call the server refuses).
      setContext(() => stub);
    })().catch(() => undefined); // the route resolved the project already; a refusal leaves the plain overview
    return () => {
      disposed = true;
      held?.[Symbol.dispose]();
    };
  }, [api, projectId]);
  return context;
}

function ProjectOverview() {
  const { project } = Route.useRouteContext();
  const { api, info } = shell.useRouteContext();
  // its organization — the name and the person's role — from the tree, live
  const org = useOrganizationTree().organizations.find(
    (candidate) => candidate.id === project.orgId,
  );
  const host = projectHostOf(info, project.slug);
  const context = useProjectContext(api, project.id);
  const live = useLiveState<unknown>(context, {
    key: "project",
    door: async () =>
      z
        .object({ rev: z.number(), state: z.unknown() })
        .parse(await context!.invoke("itx.facets.get('project').liveSnapshot()")),
  });
  const parsed = ProjectLive.safeParse(live.value).data;
  const creation = parsed?.creation ?? null;
  const configRepoSeeded = Boolean(parsed?.repos["/repos/config"]);
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-4 md:p-8">
      {creation?.status === "requested" ? (
        <ProjectCreationProgress configRepoSeeded={configRepoSeeded} />
      ) : null}
      {creation?.status === "failed" && context ? (
        <ProjectCreationFailed context={context} offset={creation.offset} />
      ) : null}
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
          {org ? <span>{org.name}</span> : null}
          <Identifier value={project.orgId} />
        </dd>
      </dl>
    </div>
  );
}

/** apps/os's "Creating project" checklist at the size os-next carries: the request is in (the
 *  directory row and `project/create-requested` — this page exists because it is) and the
 *  certificate is what the project processor owes; the live state swaps this out the moment it lands. */
function ProjectCreationProgress({ configRepoSeeded }: { configRepoSeeded: boolean }) {
  const steps = [
    { key: "registered", label: "Registering project", done: true },
    { key: "repo", label: "Seeding the config repository", done: configRepoSeeded },
    { key: "created", label: "Publishing the homepage", done: false },
  ];
  return (
    <section className="rounded-lg border bg-card p-6" data-testid="project-creation-progress">
      <h2 className="text-lg font-semibold">Creating your project</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Setting everything up — this page updates live as each step lands.
      </p>
      <ol className="mt-5 space-y-3">
        {steps.map((step) => (
          <li
            key={step.key}
            className="flex items-center gap-3 text-sm"
            data-testid={`creation-step-${step.key}`}
            data-done={step.done ? "true" : undefined}
          >
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full border",
                step.done
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-muted-foreground/30 text-muted-foreground",
              )}
            >
              {step.done ? (
                <CheckIcon aria-hidden="true" className="size-4" />
              ) : (
                <LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin" />
              )}
            </span>
            <span className={step.done ? "text-foreground" : "text-muted-foreground"}>
              {step.label}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The failure the project processor reported: the state keeps the OFFSET of `project/create-failed`
 *  on `/`, the event itself the words — read here, one row. */
function ProjectCreationFailed({ context, offset }: { context: ProjectContext; offset: number }) {
  const [error, setError] = useState<string>();
  useEffect(() => {
    let disposed = false;
    // `readEvents(after, limit)` answers the rows past `after`: the failure's own, first
    context
      .invoke(["itx", ["readEvents", offset - 1, 1]])
      .then((page) => {
        if (disposed) return;
        const read = z
          .object({
            events: z.array(z.looseObject({ payload: z.looseObject({ error: z.string() }) })),
          })
          .safeParse(page);
        setError(read.data?.events[0]?.payload.error ?? "The failure's event could not be read.");
      })
      .catch(
        (caught: unknown) =>
          !disposed && setError(caught instanceof Error ? caught.message : String(caught)),
      );
    return () => {
      disposed = true;
    };
  }, [context, offset]);
  return (
    <section
      className="rounded-lg border border-destructive/40 bg-card p-6"
      data-testid="project-creation-failed"
    >
      <div className="flex items-center gap-2 text-destructive">
        <CircleXIcon aria-hidden="true" className="size-5" />
        <h2 className="text-lg font-semibold">Project creation failed</h2>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">{error || "Reading what went wrong…"}</p>
      <p className="mt-2 text-sm text-muted-foreground">
        Try again — creating the project once more from the projects page is a new attempt; the
        project's log keeps the whole trail.
      </p>
    </section>
  );
}
