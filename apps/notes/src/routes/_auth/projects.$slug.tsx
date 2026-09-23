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
      account={{ email: info.principal.email || info.principal.actor }}
      locationKey={href}
    >
      {/* the loader sends a sign-in the project is missing from off to sign in again */}
      <Editor key={data.project.id} project={data.project.id} initial={data.note} tip={data.tip} />
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
        <p role="alert" data-type="error" className="text-sm break-words text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
