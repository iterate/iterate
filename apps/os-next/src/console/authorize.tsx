// console/authorize.tsx — THE CONSENT PAGE of the OAuth authorization server (/authorize): the page
// only the issuer may render. The client's OAuth query is the page's identity — `key={answer.query}`
// resets the choices for a new request and keeps them across a directory refresh (a created org or
// project re-describes the same query). Everything is the session's `consent` capability
// (src/consent.ts): `describe` reads, `approve` completes the authorization and hands back the
// client's redirect; a first-time user creates an organization and a project right here.
import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from "react";
import type { AuthenticatedApp } from "iterate/next/app";
import type { ConsentAnswer } from "iterate/next/api";

type Consent = Extract<ConsentAnswer, { kind: "consent" }>;
type Org = Consent["orgs"][number];
type Api = AuthenticatedApp["api"];

export function AuthorizePage({ app }: { app: AuthenticatedApp }) {
  const { api } = app;
  const query = window.location.search;
  const [answer, setAnswer] = useState<ConsentAnswer | null>(null);
  const [describeError, setDescribeError] = useState<string | null>(null);
  // Preserve the client's OAuth query throughout project selection and onboarding.
  const describe = useCallback(async () => {
    const described = await api.consent.describe(query);
    if (described.kind === "redirect") {
      window.location.replace(described.location);
      return;
    }
    setAnswer(described);
  }, [api, query]);
  useEffect(() => {
    describe().catch((caught: unknown) =>
      setDescribeError(caught instanceof Error ? caught.message : String(caught)),
    );
  }, [describe]);

  if (describeError)
    return (
      <main>
        <h1>Authorization could not be read</h1>
        <p role="alert">{describeError}</p>
      </main>
    );
  if (!answer) return <main aria-busy="true" />;
  if (answer.kind === "invalid")
    return (
      <main>
        <h1>Invalid authorization request</h1>
        <p>{answer.description}</p>
      </main>
    );
  if (answer.kind === "redirect") return <main aria-busy="true" />;
  // A new authorization request resets choices; a directory refresh does not.
  return <ConsentPage key={answer.query} answer={answer} api={api} refresh={describe} />;
}

function ConsentPage({
  answer,
  api,
  refresh,
}: {
  answer: Consent;
  api: Api;
  refresh: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "working" | "approved">("idle");
  const busy = status !== "idle";
  // Newly created projects start selected; refreshing the directory preserves every deselection.
  const [excluded, setExcluded] = useState(() => new Set<string>());
  const [allProjects, setAllProjects] = useState(false);

  const { query, clientName, email, projects, orgs, projectBound, scopes, denyLocation } = answer;
  const selected = projects.filter((project) => !excluded.has(project.id));
  const perform = async (work: () => Promise<void>) => {
    setError(null);
    setStatus("working");
    try {
      await work();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStatus("idle");
    }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setStatus("working");
    try {
      const result = await api.consent.approve({
        query,
        projects: allProjects ? ["*"] : selected.map((project) => project.id),
      });
      if ("error" in result) throw new Error(result.error);
      // A native-client redirect can leave this page open; approval stays disabled.
      setStatus("approved");
      window.location.replace(result.redirectTo);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setStatus("idle");
    }
  };
  const loginAgain = `/login?next=${encodeURIComponent(`/authorize${query}`)}`;

  return (
    <main className="consent-card" aria-busy={status === "working"}>
      <header>
        <div className="consent-app">
          <span className="consent-avatar" aria-hidden="true">
            {clientName.slice(0, 2).toUpperCase()}
          </span>
          <div>
            <span className="consent-badge">Project access</span>
            <h1>Authorize {clientName}</h1>
          </div>
        </div>
        <p className="muted">
          {projectBound
            ? "Review access to this app’s project."
            : "Choose which projects this app can use."}
        </p>
      </header>
      <section className="consent-account" aria-label="Signed-in account">
        <span className="consent-avatar" aria-hidden="true">
          {email.slice(0, 1).toUpperCase()}
        </span>
        <div>
          <span className="muted">Signed in as</span>
          <strong>{email}</strong>
        </div>
        <form method="post" action={`/.auth/logout?next=${encodeURIComponent(loginAgain)}`}>
          <button className="consent-quiet" type="submit" disabled={busy}>
            Switch account
          </button>
        </form>
      </section>
      <form id="consent" onSubmit={submit}>
        {scopes.includes("account") && (
          <p>
            <strong>Account permission:</strong> this app can view and end all your sessions and
            create personal access tokens for the projects you grant it.
          </p>
        )}
        <ProjectPicker
          orgs={orgs}
          projects={projects}
          projectBound={projectBound}
          excluded={excluded}
          allProjects={allProjects}
          busy={busy}
          setExcluded={setExcluded}
          setAllProjects={setAllProjects}
        />
      </form>
      {!projectBound && (
        <ProjectSetup
          api={api}
          orgs={orgs}
          hasProjects={projects.length > 0}
          busy={busy}
          perform={perform}
          refresh={refresh}
        />
      )}
      <footer>
        {error && (
          <p role="alert" data-type="error">
            {error}
          </p>
        )}
        {busy && (
          <p role="status">
            {status === "approved" ? "Access approved. You can return to the app." : "Working…"}
          </p>
        )}
        <div className="consent-actions">
          <a href={denyLocation}>Cancel</a>
          <button
            type="submit"
            form="consent"
            disabled={busy || (!allProjects && !selected.length)}
          >
            Approve
          </button>
        </div>
      </footer>
    </main>
  );
}

function ProjectSetup({
  api,
  orgs,
  hasProjects,
  busy,
  perform,
  refresh,
}: {
  api: Api;
  orgs: Org[];
  hasProjects: boolean;
  busy: boolean;
  perform: (work: () => Promise<void>) => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const [orgId, setOrgId] = useState("");
  return (
    <details className="consent-create" open={!hasProjects}>
      <summary>
        <h2>
          {orgs.length ? "Create a project or organization" : "Create your first organization"}
        </h2>
      </summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const name = String(new FormData(form).get("name") || "");
          void perform(async () => {
            const org = await api.createOrg(name);
            setOrgId(org.id);
            form.reset();
            await refresh();
          });
        }}
      >
        <label>
          Organization name
          <input type="text" name="name" disabled={busy} required />
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
              await refresh();
            });
          }}
        >
          <label>
            Organization
            <select
              name="org"
              disabled={busy}
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
            <input type="text" name="name" disabled={busy} required />
          </label>
          <button type="submit" disabled={busy}>
            Create project
          </button>
        </form>
      )}
    </details>
  );
}

function ProjectPicker({
  orgs,
  projects,
  projectBound,
  excluded,
  allProjects,
  busy,
  setExcluded,
  setAllProjects,
}: {
  orgs: Org[];
  projects: Consent["projects"];
  projectBound: boolean;
  excluded: Set<string>;
  allProjects: boolean;
  busy: boolean;
  setExcluded: Dispatch<SetStateAction<Set<string>>>;
  setAllProjects: (all: boolean) => void;
}) {
  const names = new Map(orgs.map((org) => [org.id, org.name]));
  const selected = projects.filter((project) => !excluded.has(project.id));
  return (
    <>
      <div className="consent-project-heading">
        <div>
          <h2>Projects</h2>
          <p className="muted" role="status">
            {allProjects ? "All current and future projects" : `${selected.length} selected`}
          </p>
        </div>
        {projects.length > 1 && (
          <div>
            <button
              className="consent-quiet"
              type="button"
              disabled={busy || allProjects}
              onClick={() => setExcluded(new Set())}
            >
              Select all
            </button>
            <button
              className="consent-quiet"
              type="button"
              disabled={busy || allProjects}
              onClick={() => setExcluded(new Set(projects.map((project) => project.id)))}
            >
              Clear
            </button>
          </div>
        )}
      </div>
      <fieldset
        className="consent-projects"
        aria-label="Projects it may reach"
        disabled={busy || allProjects}
      >
        {projects.length ? (
          [...new Set(projects.map((project) => project.orgId))].map((orgId) => {
            const group = projects.filter((project) => project.orgId === orgId);
            const orgName = names.get(orgId) || orgId;
            return (
              <section className="consent-org" key={orgId} aria-label={orgName}>
                <h3>
                  {orgName}
                  <span className="muted">
                    {group.length} {group.length === 1 ? "project" : "projects"}
                  </span>
                </h3>
                {group.map((project) => (
                  <label className="consent-project" key={project.id}>
                    <input
                      type="checkbox"
                      name="project"
                      value={project.id}
                      aria-label={`${project.id} in ${orgName}`}
                      checked={allProjects || !excluded.has(project.id)}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        setExcluded((current) => {
                          const next = new Set(current);
                          if (checked) next.delete(project.id);
                          else next.add(project.id);
                          return next;
                        });
                      }}
                    />
                    <strong>{project.id}</strong>
                  </label>
                ))}
              </section>
            );
          })
        ) : (
          <p className="muted">
            {projectBound
              ? "You do not have access to this app’s project."
              : "Create your first organization and project below, then approve access."}
          </p>
        )}
      </fieldset>
      {!projectBound && projects.length > 0 && (
        <label className="consent-future">
          <input
            type="checkbox"
            checked={allProjects}
            disabled={busy}
            aria-label="All my current and future projects"
            onChange={(event) => setAllProjects(event.target.checked)}
          />
          <span>
            <strong>All my current and future projects</strong>
            <span className="muted">Include projects you create or join later.</span>
          </span>
        </label>
      )}
      <p className="muted">This app can read and make changes in the projects you grant it.</p>
    </>
  );
}
