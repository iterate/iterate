import { useState, type FormEvent } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { iterate } from "./-client.ts";

export const Route = createFileRoute("/authorize")({
  ssr: false,
  beforeLoad: () => iterate.authenticate(window.location.pathname + window.location.search),
  loader: async ({ context }) => {
    // OAuth allows repeated keys and form-encoded spaces. The router search codec
    // is for application state; this protocol query must remain byte-for-byte intact.
    const answer = await context.api.consent.describe(window.location.search);
    if (answer.kind === "redirect") throw redirect({ href: answer.location, reloadDocument: true });
    return answer;
  },
  component: ConsentPage,
});

function ConsentPage() {
  const answer = Route.useLoaderData();
  const { api } = Route.useRouteContext();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [orgId, setOrgId] = useState("");

  if (answer.kind === "invalid")
    return (
      <main>
        <h1>Invalid authorization request</h1>
        <p>{answer.description}</p>
      </main>
    );

  const { query, clientName, email, projects, orgs, projectBound, scopes, denyLocation } = answer;
  const perform = async (work: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await work();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const chosen = new FormData(event.currentTarget).getAll("project").map(String);
    void perform(async () => {
      const result = await api.consent.approve({ query, projects: chosen });
      if ("error" in result) throw new Error(result.error);
      window.location.assign(result.redirectTo);
    });
  };
  const loginAgain = `/login?next=${encodeURIComponent(`/authorize${query}`)}`;

  return (
    <main>
      <h1>Authorize {clientName}</h1>
      <p>
        <strong>{clientName}</strong> wants to connect as <strong>{email}</strong>.
      </p>
      <form onSubmit={submit}>
        {scopes.includes("account") && (
          <p>
            <strong>Account permission:</strong> this app can view and end all your sessions and
            create API tokens for the projects you grant it.
          </p>
        )}
        <fieldset disabled={busy}>
          <legend>Projects it may reach</legend>
          {!projectBound && (
            <label>
              <input type="checkbox" name="project" value="*" /> All my current and future projects
            </label>
          )}
          {projects.length ? (
            projects.map((project) => (
              <label key={project.id}>
                <input type="checkbox" name="project" value={project.id} defaultChecked />{" "}
                <code>{project.id}</code>{" "}
                <span className="muted">
                  in {orgs.find((org) => org.id === project.orgId)?.name || project.orgId}
                </span>
              </label>
            ))
          ) : (
            <p className="muted">
              {projectBound
                ? "You do not have access to this app’s project."
                : "Create your first organization and project below, then approve access."}
            </p>
          )}
        </fieldset>
        <button type="submit" disabled={busy}>
          Approve
        </button>
        <a href={denyLocation}>Cancel</a>
      </form>
      {!projectBound && (
        <section aria-label="Create an organization or project">
          <h2>{orgs.length ? "Organizations and projects" : "Create your first organization"}</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const name = String(new FormData(form).get("name") || "");
              void perform(async () => {
                const org = await api.createOrg(name);
                setOrgId(org.id);
                form.reset();
                await router.invalidate();
              });
            }}
          >
            <label>
              Organization name
              <input type="text" name="name" required />
            </label>
            <button type="submit" disabled={busy}>
              Create organization
            </button>
          </form>
          {orgs.length > 0 && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const data = new FormData(form);
                void perform(async () => {
                  using _project = await api.projects.create({
                    project: String(data.get("name")),
                    orgId: String(data.get("org")),
                  });
                  form.reset();
                  await router.invalidate();
                });
              }}
            >
              <label>
                Organization
                <select
                  name="org"
                  value={orgId || orgs[0]!.id}
                  onChange={(event) => setOrgId(event.target.value)}
                >
                  {orgs.map((org) => (
                    <option key={org.id} value={org.id}>
                      {org.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Project name
                <input type="text" name="name" required />
              </label>
              <button type="submit" disabled={busy}>
                Create project
              </button>
            </form>
          )}
        </section>
      )}
      {error && <p role="alert">{error}</p>}
      <form method="post" action={`/.auth/logout?next=${encodeURIComponent(loginAgain)}`}>
        <button type="submit" disabled={busy}>
          Switch account
        </button>
      </form>
    </main>
  );
}
