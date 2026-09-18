import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { z } from "zod";
import { AppShell } from "@iterate-com/ui/components/app-shell";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@iterate-com/ui/components/breadcrumb";
import { Button } from "@iterate-com/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@iterate-com/ui/components/empty";
import { Field, FieldLabel } from "@iterate-com/ui/components/field";
import { Textarea } from "@iterate-com/ui/components/textarea";

// The note is a FILE in the project's config repo, edited through a workspace: the loader brings
// the repo and the workspace into being (`create()` is idempotent), reads the file through the
// workspace (its overlay, else the repo's tip), and Save writes the overlay and commits it — ONE
// commit on the repo's main per save, through `itx.workspaces.get(WORKSPACE).gitCommit`.
const REPO = "/repos/config";
const WORKSPACE = "/workspaces/notes";
const FILE = `${REPO}/notes/log.md`;

export const Route = createFileRoute("/_auth/notes")({
  validateSearch: z.object({ project: z.string().optional() }),
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps }) => {
    const projects = await context.api.projects.list();
    const project = deps.project ? projects.find((item) => item.id === deps.project) : projects[0];
    if (deps.project && !project) throw new Error("This session cannot access that project.");
    let note = "";
    let tip: string | null = null;
    if (project) {
      using itx = await context.api.projects.get(project.id);
      await itx.invoke(["itx", "repos", ["get", REPO], ["create"]]);
      await itx.invoke(["itx", "workspaces", ["get", WORKSPACE], ["create"]]);
      note =
        z
          .string()
          .nullable()
          .parse(await itx.invoke(["itx", "workspaces", ["get", WORKSPACE], ["readFile", FILE]])) ??
        "";
      tip = z
        .string()
        .nullable()
        .parse(await itx.invoke(["itx", "repos", ["get", REPO], ["tip"]]));
    }
    return { projects, project, note, tip };
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
      activeProjectId={data.project?.id || null}
      projectHref={(projectId) => `/notes?project=${encodeURIComponent(projectId)}`}
      header={
        data.project ? (
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem className="hidden md:inline-flex">Notes</BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:inline-flex" />
              <BreadcrumbItem>
                <BreadcrumbPage className="font-mono">{data.project.id}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        ) : null
      }
      account={{ email: info.principal.email || info.principal.actor }}
      locationKey={href}
    >
      {data.project ? (
        <Editor
          key={data.project.id}
          project={data.project.id}
          initial={data.note}
          tip={data.tip}
        />
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No projects yet</EmptyTitle>
            <EmptyDescription>
              <a href="https://dash.iterate2.com/projects" className="underline underline-offset-4">
                Create a project
              </a>{" "}
              in the dash to give a note a home.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </AppShell>
  );
}

const Commit = z.object({ commitOid: z.string().nullable(), changedPaths: z.array(z.string()) });

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
        <Button type="submit" disabled={pending}>
          Save
        </Button>
        <span role="status" className="text-sm text-muted-foreground">
          {status}
        </span>
      </div>
      {error ? (
        <p role="alert" className="text-sm break-words text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
