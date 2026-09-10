// _auth/authorize.tsx — /authorize: the OAuth consent AND THE PROJECT SELECTION. The provider's
// authorize endpoint (control-plane.ts `authorizeEndpoint: "/authorize"`), so the file is named for
// the path. The OAuth parameters ride the URL verbatim — the server fn hands the raw query to
// `env.OAUTH_PROVIDER.parseAuthRequest` (control-plane.ts `consentOf`); a request the provider
// refuses is sent back to the client with `error` (`AuthorizationError.redirectUri`) or shown here.
// The user's projects are checkboxes, all checked; approving grants the client the USER on the
// checked ones (`completeAuthorization` — `props.actor / email / projects`, what every /mcp tool
// acts within), then the browser goes to the client's redirect URI. The form is a real one —
// `method="post"` to the machine's approve door, `POST /authorize?<the same query>` (control-plane.ts
// `consoleDoor`, the same `approveConsent`), the server function taking over once hydrated
// (login.tsx says why).
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

  const { query, clientName, email, projects, projectBound } = answer;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const chosen = new FormData(event.currentTarget).getAll("project").map(String);
    setError(null);
    try {
      const { redirectTo } = await approve({ data: { query, projects: chosen } });
      window.location.assign(redirectTo);
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
