// Issuer consent uses Start server functions; app data uses the public RPC session.
import { useState, type FormEvent } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { approveConsent, consentOf, signOut } from "../control-plane.ts";
import { issuerOf } from "./-session.ts";
import { consoleContext } from "./-console-context.ts";

const consent = createServerFn({ method: "GET" })
  .middleware([consoleContext])
  .inputValidator((data: { query: string }) => data)
  .handler(({ data, context }) => consentOf(context.env, context.request, data.query));

const approve = createServerFn({ method: "POST" })
  .middleware([consoleContext])
  .inputValidator((data: { query: string; projects: string[] }) => data)
  .handler(({ data, context }) =>
    approveConsent(context.env, context.request, data.query, data.projects),
  );

const logout = createServerFn({ method: "POST" }).handler(() => {
  setResponseHeader("set-cookie", signOut());
  return null;
});

export const Route = createFileRoute("/authorize")({
  beforeLoad: async ({ location }) => {
    if (!(await issuerOf())) throw redirect({ to: "/login", search: { next: location.href } });
    const answer = await consent({ data: { query: location.searchStr } });
    // the provider's refusal, sent back to the client (its redirect URI validated) as the README says
    if (answer.kind === "redirect") throw redirect({ href: answer.location, statusCode: 302 });
    return { consent: answer };
  },
  loader: ({ context }) => context.consent,
  component: ConsentPage,
});

function ConsentPage() {
  const answer = Route.useLoaderData();
  const [error, setError] = useState<string | null>(null);

  if (answer.kind === "invalid")
    return (
      <main>
        <h1>Invalid authorization request</h1>
        <p>{answer.description}</p>
      </main>
    );

  const { query, clientName, email, projects, projectBound, scopes } = answer;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const chosen = new FormData(event.currentTarget).getAll("project").map(String);
    setError(null);
    try {
      const answer = await approve({ data: { query, projects: chosen } });
      if ("error" in answer) throw new Error(answer.error);
      window.location.assign(answer.redirectTo);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };
  // "switch account": the session cleared, the login form with this consent as its `next`
  const loginAgain = `/login?next=${encodeURIComponent(`/authorize${query}`)}`;

  return (
    <main>
      <h1>Authorize {clientName}</h1>
      <p>
        <strong>{clientName}</strong> wants to connect as <strong>{email}</strong>.
      </p>
      <form method="post" action={`/authorize${query}`} onSubmit={submit}>
        {scopes.includes("account") && (
          <p>
            <strong>Account permission:</strong> this app can view and end all your sessions and
            create API tokens for the projects you grant it.
          </p>
        )}
        <fieldset>
          <legend>Projects it may reach</legend>
          {!projectBound && (
            <label>
              <input
                type="checkbox"
                name="project"
                value="*"
                defaultChecked={projects.length === 0}
              />{" "}
              All my current and future projects
            </label>
          )}
          {projects.length ? (
            projects.map((project) => (
              <label key={project.id}>
                <input type="checkbox" name="project" value={project.id} defaultChecked />{" "}
                <code>{project.id}</code> <span className="muted">in {project.orgId}</span>
              </label>
            ))
          ) : (
            <p className="muted">No projects to choose from yet.</p>
          )}
        </fieldset>
        <button type="submit">Approve</button>
      </form>
      {error && <p role="alert">{error}</p>}
      <form
        method="post"
        action={`/logout?next=${encodeURIComponent(loginAgain)}`}
        onSubmit={async (event) => {
          event.preventDefault();
          await logout();
          window.location.assign(loginAgain);
        }}
      >
        <button type="submit">Switch account</button>
      </form>
    </main>
  );
}
