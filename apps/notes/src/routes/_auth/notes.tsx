import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { z } from "zod";

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
  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">NOTES</p>
          <h1>A little room to think.</h1>
        </div>
        <form method="post" action="/.auth/logout">
          <button type="submit">Log out</button>
        </form>
      </header>
      <p id="identity">{info.principal.email || info.principal.actor}</p>
      {data.projects.length > 1 && (
        <nav aria-label="Projects">
          {data.projects.map((project) => (
            <span key={project.id}>
              <Link to="/notes" search={{ project: project.id }}>
                {project.id}
              </Link>{" "}
            </span>
          ))}
        </nav>
      )}
      {data.project ? (
        <Editor
          key={data.project.id}
          project={data.project.id}
          initial={data.note}
          tip={data.tip}
        />
      ) : (
        <p>
          No projects yet. <Link to="/dashboard">Create a project</Link>.
        </p>
      )}
      <p>
        <Link to="/dashboard">Project dashboard</Link>
      </p>
    </main>
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
    <form onSubmit={save}>
      <label htmlFor="note">
        {project} · {FILE}
      </label>
      <textarea id="note" value={note} onChange={(event) => setNote(event.target.value)} />
      <div className="actions">
        <button type="submit" disabled={pending}>
          Save and commit
        </button>
        <span role="status">{status}</span>
      </div>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
