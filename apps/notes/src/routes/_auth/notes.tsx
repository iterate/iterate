import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { z } from "zod";

export const Route = createFileRoute("/_auth/notes")({
  validateSearch: z.object({ project: z.string().optional() }),
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps }) => {
    const projects = await context.api.projects.list();
    const project = deps.project ? projects.find((item) => item.id === deps.project) : projects[0];
    if (deps.project && !project) throw new Error("This session cannot access that project.");
    let note = "";
    if (project) {
      using itx = await context.api.projects.get(project.id);
      note =
        z
          .string()
          .nullable()
          .parse(await itx.invoke(["itx", "kv", ["get", "notes.document"]])) ?? "";
    }
    return { projects, project, note };
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
        <Editor key={data.project.id} project={data.project.id} initial={data.note} />
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
function Editor({ project, initial }: { project: string; initial: string }) {
  const { api } = Route.useRouteContext();
  const [note, setNote] = useState(initial);
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setStatus("Saving…");
    try {
      using itx = await api.projects.get(project);
      await itx.invoke(["itx", "kv", ["put", "notes.document", note]]);
      setStatus("Saved");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setStatus("Could not save. Your text is still here.");
    } finally {
      setPending(false);
    }
  }
  return (
    <form onSubmit={save}>
      <label htmlFor="note">{project}</label>
      <textarea id="note" value={note} onChange={(event) => setNote(event.target.value)} />
      <div className="actions">
        <button type="submit" disabled={pending}>
          Save note
        </button>
        <span role="status">{status}</span>
      </div>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
