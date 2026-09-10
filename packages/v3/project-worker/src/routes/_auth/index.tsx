import { useState, type FormEvent } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { accountOf, createProjectFor } from "../../control-plane.ts";
import { consoleContext } from "../-console-context.ts";

const account = createServerFn({ method: "GET" })
  .middleware([consoleContext])
  .handler(({ context }) => accountOf(context.env, context.request, context.ctx));

/** The console's create door — `directory.createProject({ userId }, name)`, the same door as
 *  `projects.create` over /api and the machine's `POST /projects` (control-plane.ts). */
const createProject = createServerFn({ method: "POST" })
  .middleware([consoleContext])
  .inputValidator((data: { name: string }) => data)
  .handler(({ data, context }) =>
    createProjectFor(context.env, context.request, data.name, context.ctx),
  );

export const Route = createFileRoute("/_auth/")({
  loader: () => account(),
  component: AccountPage,
});

function AccountPage() {
  const { email, orgs, projects } = Route.useLoaderData();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    setError(null);
    try {
      await createProject({ data: { name: String(new FormData(form).get("slug") ?? "") } });
      form.reset();
      await router.invalidate(); // the loader lists it now
    } catch (caught) {
      // a name another org holds — the visitor's problem, shown, not a 500
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

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
        <p className="muted">No orgs yet.</p>
      )}
      <h2>Projects</h2>
      {projects.length ? (
        <ul>
          {projects.map((project) => (
            <li key={project.id}>
              <code>{project.id}</code> <span className="muted">in {project.orgId}</span>
              {project.open && (
                <>
                  {" "}
                  <a href={project.open}>open</a>
                </>
              )}
              {project.apps.map((app) => (
                <span key={app.label}>
                  {" "}
                  <a href={app.open}>open {app.label}</a>
                </span>
              ))}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No projects yet.</p>
      )}
      <form method="post" action="/projects" onSubmit={create}>
        <label>
          New project
          <input type="text" name="slug" placeholder="new-project-slug" required />
        </label>
        <button type="submit">Create project</button>
      </form>
      {error && <p role="alert">{error}</p>}
      <p>
        <a href="/sessions">Sessions</a>
      </p>
      <form method="post" action="/.auth/logout">
        <button type="submit">Log out</button>
      </form>
    </main>
  );
}
