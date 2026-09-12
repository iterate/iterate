import { useState, type FormEvent } from "react";
import type { loadDashboard } from "./dashboard-data.ts";

/** Shared verbatim by the fixed console and the independently deployed clone. */
export function Dashboard({
  data,
  createProject,
}: {
  data: Awaited<ReturnType<typeof loadDashboard>>;
  createProject: (name: string) => Promise<void>;
}) {
  const { email, orgs, projects, canManageAccount } = data;
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setError(null);
    setPending(true);
    try {
      await createProject(String(new FormData(form).get("slug") ?? ""));
      form.reset();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  }
  return (
    <main>
      <h1>Signed in as {email}</h1>
      <h2>Orgs</h2>
      {orgs.length ? (
        <ul>
          {orgs.map((org) => (
            <li key={org.id}>
              {org.name} <span className="muted">({org.role})</span>
            </li>
          ))}
        </ul>
      ) : (
        <p>No orgs yet.</p>
      )}
      <h2>Projects</h2>
      {projects.length ? (
        <ul>
          {projects.map((project) => (
            <li key={project.id}>
              <code>{project.id}</code> <span className="muted">in {project.orgId}</span>{" "}
              {project.open && <a href={project.open}>open</a>}
              {project.apps.map((app) => (
                <span key={app.label}>
                  {" "}
                  <a href={app.open}>open {app.label}</a>
                </span>
              ))}
              {project.appError && <p role="alert">App listing unavailable: {project.appError}</p>}
            </li>
          ))}
        </ul>
      ) : (
        <p>No projects yet.</p>
      )}
      <form onSubmit={create}>
        <label>
          New project <input name="slug" placeholder="new-project-slug" required />
        </label>
        <button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create project"}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {canManageAccount && (
        <p>
          <a href="/sessions">Sessions</a>
        </p>
      )}
      <form method="post" action="/.auth/logout">
        <button type="submit">Log out</button>
      </form>
    </main>
  );
}
