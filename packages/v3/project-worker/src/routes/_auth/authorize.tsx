// _auth/authorize.tsx — /authorize: the OAuth consent AND THE PROJECT SELECTION. The provider's
// authorize endpoint (control-plane.ts `authorizeEndpoint: "/authorize"`), so the file is named for
// the path. The OAuth parameters ride the URL verbatim — the server fn hands the raw query to
// `env.OAUTH_PROVIDER.parseAuthRequest` (control-plane.ts `consentOf`); a request the provider
// refuses is sent back to the client with `error` (`AuthorizationError.redirectUri`) or shown here.
// The user's projects are checkboxes, all checked; approving grants the client the USER on the
// checked ones (`completeAuthorization` — `props.actor / email / projects`, what every /mcp tool
// acts within), then the browser goes to the client's redirect URI. The machine's approve door is
// `POST /authorize` (a form), the same `approveConsent`.
import { useState, type FormEvent } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { approveConsent, consentOf, signOut } from "../../control-plane.ts";
import { consoleContext } from "../-console-context.ts";

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

export const Route = createFileRoute("/_auth/authorize")({
  beforeLoad: async ({ location }) => {
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
  const [chosen, setChosen] = useState<string[]>(() =>
    answer.kind === "consent" ? answer.projects.map((project) => project.id) : [],
  );
  const [error, setError] = useState<string | null>(null);

  if (answer.kind === "invalid")
    return (
      <main>
        <h1>Invalid authorization request</h1>
        <p>{answer.description}</p>
      </main>
    );

  const { query, clientName, email, projects } = answer;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    try {
      const { redirectTo } = await approve({ data: { query, projects: chosen } });
      window.location.assign(redirectTo);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };
  const switchAccount = async () => {
    await logout();
    window.location.assign(`/login?next=${encodeURIComponent(`/authorize${query}`)}`);
  };

  return (
    <main>
      <h1>Authorize {clientName}</h1>
      <p>
        <strong>{clientName}</strong> wants to connect as <strong>{email}</strong>.
      </p>
      <form onSubmit={submit}>
        <fieldset>
          <legend>Projects it may reach</legend>
          {projects.length ? (
            projects.map((project) => (
              <label key={project.id}>
                <input
                  type="checkbox"
                  name="project"
                  value={project.id}
                  checked={chosen.includes(project.id)}
                  onChange={(event) =>
                    setChosen((previous) =>
                      event.target.checked
                        ? [...previous, project.id]
                        : previous.filter((id) => id !== project.id),
                    )
                  }
                />{" "}
                <code>{project.id}</code> <span className="muted">in {project.orgId}</span>
              </label>
            ))
          ) : (
            <p className="muted">No projects yet — every project you join is reachable.</p>
          )}
        </fieldset>
        <button type="submit">Approve</button>
      </form>
      {error && <p role="alert">{error}</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void switchAccount();
        }}
      >
        <button type="submit">Switch account</button>
      </form>
    </main>
  );
}
