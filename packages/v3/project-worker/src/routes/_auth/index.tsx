// _auth/index.tsx — /: the account page. The user's orgs and projects; each project's "open" link is
// its apex host's `/.itx/session?token=…` (a project token for this user, minted server-side, good for
// 15 minutes — the host-scoped cookie there, worker.ts `projectSessionResponse`) and one more per app
// the project serves (`itx.apps.<label>` in its root context's rewrite table): a `__Host-` cookie is
// its host's alone, so every host signs in through its own door. A create-project form and log out —
// real forms, `method="post"` to the machine doors (control-plane.ts `consoleDoor`), the server
// functions taking over once hydrated (login.tsx says why).
import { useState, type FormEvent } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { accountOf, createProjectFor, signOut } from "../../control-plane.ts";
import { consoleContext } from "../-console-context.ts";

const account = createServerFn({ method: "GET" })
  .middleware([consoleContext])
  .handler(({ context }) => accountOf(context.env, context.request));

/** The console's create door — `directory.createProject({ userId }, name)`, the same door as
 *  `projects.create` over /api and the machine's `POST /projects` (control-plane.ts). */
const createProject = createServerFn({ method: "POST" })
  .middleware([consoleContext])
  .inputValidator((data: { name: string }) => data)
  .handler(({ data, context }) => createProjectFor(context.env, context.request, data.name));

/** Log out: the cookie cleared on this response. The machine's is `POST /logout`. */
const logout = createServerFn({ method: "POST" }).handler(() => {
  setResponseHeader("set-cookie", signOut());
  return null;
});

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
      <form
        method="post"
        action="/logout"
        onSubmit={async (event) => {
          event.preventDefault();
          await logout();
          await router.navigate({ to: "/login", search: { next: "/" } });
        }}
      >
        <button type="submit">Log out</button>
      </form>
    </main>
  );
}
