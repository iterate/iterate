import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import type { AuthenticatedApp } from "iterate/app";
import { useFacetLiveState } from "iterate/react";
import { AppShell } from "@iterate-com/ui/components/app-shell";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@iterate-com/ui/components/breadcrumb";
import { Button } from "@iterate-com/ui/components/button";
import { Field, FieldLabel } from "@iterate-com/ui/components/field";
import { Textarea } from "@iterate-com/ui/components/textarea";

// Notes edits a file in the config repo through a project workspace.
const REPO = "/repos/config";
const WORKSPACE = "/workspaces/notes";
const FILE = `${REPO}/notes/log.md`;

export const Route = createFileRoute("/_auth/projects/$slug")({
  loader: async ({ context, params }) => {
    const projects = await context.api.projects.list();
    // the URL names the project by slug (its id works too); one this sign-in lacks → sign in again
    const project = projects.find((item) => item.slug === params.slug || item.id === params.slug);
    if (!project) return context.signInFor(params.slug);
    // the project's root context, pipelined: the calls below ride it before it has resolved
    using itx = context.api.projects.get(project.id);
    await Promise.all([
      itx.invoke(["itx", "workspaces", ["create", WORKSPACE]]),
      itx.invoke(["itx", "repos", ["create", REPO]]),
    ]);
    // Both must exist before reading: the workspace discovers mounts from the repo catalog.
    const [note, tip] = await Promise.all([
      itx.invoke(["itx", "workspaces", ["get", WORKSPACE], ["readFile", FILE]]),
      itx.invoke(["itx", "repos", ["get", REPO], ["tip"]]),
    ]);
    return {
      projects,
      project,
      note: z.string().nullable().parse(note) || "",
      tip: z.string().nullable().parse(tip),
    };
  },
  component: NotesPage,
});

function NotesPage() {
  const data = Route.useLoaderData();
  const { info } = Route.useRouteContext();
  const href = useRouterState({ select: (state) => state.location.href });
  return (
    <AppShell
      app="Notes"
      projects={data.projects}
      activeProjectId={data.project.id}
      projectHref={(item) => `/projects/${item.slug}`}
      header={
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem className="hidden md:inline-flex">Notes</BreadcrumbItem>
            <BreadcrumbSeparator className="hidden md:inline-flex" />
            <BreadcrumbItem>
              <BreadcrumbPage className="font-mono">{data.project.slug}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      }
      account={info.principal}
      locationKey={href}
    >
      <Editor key={data.project.id} project={data.project.id} initial={data.note} tip={data.tip} />
    </AppShell>
  );
}

const Commit = z.object({ commitOid: z.string().nullable(), changedPaths: z.array(z.string()) });

/** The project facet's live state, the one field this page reads: where the project's own creation
 *  stands (null until `project/create-requested` lands). */
const ProjectLive = z.looseObject({
  creation: z.object({ status: z.enum(["requested", "created", "failed"]) }).nullable(),
});

/** The project's root context as the page holds it: `api.projects.get(id)`, a capnweb stub. */
type ProjectContext = Awaited<ReturnType<AuthenticatedApp["api"]["projects"]["get"]>>;

/** The project's root context, held for the page's life and disposed on unmount (the dash's
 *  overview holds its own the same way). */
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
    })().catch(() => undefined); // the loader resolved the project already; a refusal leaves Save waiting
    return () => {
      disposed = true;
      held?.[Symbol.dispose]();
    };
  }, [api, projectId]);
  return context;
}

function Editor({
  project,
  initial,
  tip,
}: {
  project: string;
  initial: string;
  tip: string | null;
}) {
  const { api } = Route.useRouteContext();
  const [note, setNote] = useState(initial);
  const [status, setStatus] = useState(tip ? `At commit ${tip.slice(0, 7)}` : "Not committed yet");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // A project is usable once its creation saga lands `project/created`: until then the saga is still
  // seeding the config repo, and a commit here races it ("the commit was refused: stale ref").
  // The project facet's live state says where creation stands, as the dash's overview reads it.
  const context = useProjectContext(api, project);
  const live = useFacetLiveState(context, "project");
  const creation = ProjectLive.safeParse(live.value).data?.creation;
  const ready = creation?.status === "created";
  async function save(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setStatus("Committing…");
    try {
      using itx = await api.projects.get(project);
      await itx.invoke(["itx", "workspaces", ["get", WORKSPACE], ["writeFile", FILE, note]]);
      const committed = Commit.parse(
        await itx.invoke([
          "itx",
          "workspaces",
          ["get", WORKSPACE],
          ["gitCommit", { message: "notes: save", scope: REPO }],
        ]),
      );
      // A save that changes nothing commits nothing: the repo answers with its tip and no paths.
      setStatus(
        committed.changedPaths.length > 0 && committed.commitOid
          ? `Committed ${committed.commitOid.slice(0, 7)}`
          : `Nothing changed — still at ${committed.commitOid ? committed.commitOid.slice(0, 7) : "no commit"}`,
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setStatus("Could not commit. Your text is still here.");
    } finally {
      setPending(false);
    }
  }
  return (
    <form onSubmit={save} className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 md:p-8">
      <Field>
        <FieldLabel htmlFor="note" className="font-mono text-xs text-muted-foreground">
          {FILE}
        </FieldLabel>
        <Textarea
          id="note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          className="min-h-80 p-4 font-mono text-sm"
        />
      </Field>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={pending || !ready}>
          Save
        </Button>
        <span role="status" className="text-sm text-muted-foreground">
          {ready
            ? status
            : creation?.status === "failed"
              ? "This project could not be set up."
              : "Setting up this project…"}
        </span>
      </div>
      {error ? (
        <p role="alert" data-type="error" className="text-sm break-words text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
