// public/authorize.js — THE CONSENT PAGE of the OAuth authorization server (/authorize), the one page
// only the issuer may render — and NO BUILD: React and htm arrive through the shell's import map
// (control-plane.ts pins them on esm.sh), capnweb the same way; this file is served as it is written.
// The session is the browser's login cookie riding the `/api` WebSocket handshake
// (`authenticate({ type: "from-server-cookie" })`); everything on the page is the session's `consent`
// capability (src/consent.ts): `describe` reads, `approve` completes the authorization and hands back
// the client's redirect; a first-time user creates an organization and a project right here. The
// client's OAuth query is the page's identity — `key=${query}` resets the choices for a new request
// and keeps them across a directory refresh (a created org or project re-describes the same query).
/* oxlint-disable unicorn-js/template-indent -- htm templates are markup, indented as markup */
import { createElement, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import htm from "htm";
import { newWebSocketRpcSession } from "@iterate-com/capnweb";

const html = htm.bind(createElement);
const SCOPES = ["iterate", "account"];

/** The session. `/api` is probed over HTTP first — a 401 means "sign in", a failed WebSocket would
 *  not — then dialled; a session short of a scope goes through the login door too. The document
 *  leaves on that navigation, so the promise never settles then. */
async function connect() {
  const next = window.location.pathname + window.location.search;
  const login = `/.auth/login?${new URLSearchParams({ next, scope: SCOPES.join(" ") })}`;
  const leaveForLogin = () => {
    window.location.assign(login);
    return new Promise(() => {});
  };
  const probe = await fetch("/api", {
    method: "POST",
    body: "",
    signal: AbortSignal.timeout(10_000),
  });
  await probe.body?.cancel();
  if (probe.status === 401) return leaveForLogin();
  if (!probe.ok) throw new Error(`Iterate is unavailable (${probe.status}). Please retry.`);
  const url = new URL("/api", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const iterate = newWebSocketRpcSession(new WebSocket(url));
  // capnweb pipelines: the session stub is usable before `info` answers.
  const api = iterate.authenticate({ type: "from-server-cookie" });
  const info = await api.info();
  if (!SCOPES.every((scope) => info.scopes.includes(scope))) {
    iterate[Symbol.dispose]();
    return leaveForLogin();
  }
  return api;
}

const message = (caught) => (caught instanceof Error ? caught.message : String(caught));

function AuthorizePage({ api }) {
  const query = window.location.search;
  const [answer, setAnswer] = useState(null);
  const [describeError, setDescribeError] = useState(null);
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
    describe().catch((caught) => setDescribeError(message(caught)));
  }, [describe]);

  if (describeError)
    return html`<main>
      <h1>Authorization could not be read</h1>
      <p role="alert">${describeError}</p>
    </main>`;
  if (!answer || answer.kind === "redirect")
    return html`
      <main aria-busy="true" />
    `;
  if (answer.kind === "invalid")
    return html`<main>
      <h1>Invalid authorization request</h1>
      <p>${answer.description}</p>
    </main>`;
  // A new authorization request resets choices; a directory refresh does not.
  return html`<${ConsentPage} key=${answer.query} answer=${answer} api=${api} refresh=${describe} />`;
}

function ConsentPage({ answer, api, refresh }) {
  const [error, setError] = useState(null);
  const [status, setStatus] = useState("idle");
  const busy = status !== "idle";
  // Newly created projects start selected; refreshing the directory preserves every deselection.
  const [excluded, setExcluded] = useState(() => new Set());
  const [allProjects, setAllProjects] = useState(false);

  const { query, clientName, email, projects, orgs, projectBound, scopes, denyLocation } = answer;
  const selected = projects.filter((project) => !excluded.has(project.id));
  const perform = async (work) => {
    setError(null);
    setStatus("working");
    try {
      await work();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setStatus("idle");
    }
  };
  const submit = async (event) => {
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
      setError(message(caught));
      setStatus("idle");
    }
  };
  const loginAgain = `/login?next=${encodeURIComponent(`/authorize${query}`)}`;

  return html`<main className="consent-card" aria-busy=${status === "working"}>
    <header>
      <div className="consent-app">
        <span className="consent-avatar" aria-hidden="true">${clientName.slice(0, 2).toUpperCase()}</span>
        <div>
          <span className="consent-badge">Project access</span>
          <h1>Authorize ${clientName}</h1>
        </div>
      </div>
      <p className="muted">
        ${projectBound ? "Review access to this app’s project." : "Choose which projects this app can use."}
      </p>
    </header>
    <section className="consent-account" aria-label="Signed-in account">
      <span className="consent-avatar" aria-hidden="true">${email.slice(0, 1).toUpperCase()}</span>
      <div>
        <span className="muted">Signed in as</span>
        <strong>${email}</strong>
      </div>
      <form method="post" action=${`/.auth/logout?next=${encodeURIComponent(loginAgain)}`}>
        <button className="consent-quiet" type="submit" disabled=${busy}>Switch account</button>
      </form>
    </section>
    <form id="consent" onSubmit=${submit}>
      ${
        scopes.includes("account") &&
        html`
          <p>
            <strong>Account permission:</strong> this app can view and end all your sessions and create
            personal access tokens for the projects you grant it.
          </p>
        `
      }
      <${ProjectPicker}
        orgs=${orgs}
        projects=${projects}
        projectBound=${projectBound}
        excluded=${excluded}
        allProjects=${allProjects}
        busy=${busy}
        setExcluded=${setExcluded}
        setAllProjects=${setAllProjects}
      />
    </form>
    ${
      !projectBound &&
      html`<${ProjectSetup}
      api=${api}
      orgs=${orgs}
      hasProjects=${projects.length > 0}
      busy=${busy}
      perform=${perform}
      refresh=${refresh}
    />`
    }
    <footer>
      ${error && html`<p role="alert" data-type="error">${error}</p>`}
      ${
        busy &&
        html`<p role="status">
        ${status === "approved" ? "Access approved. You can return to the app." : "Working…"}
      </p>`
      }
      <div className="consent-actions">
        <a href=${denyLocation}>Cancel</a>
        <button type="submit" form="consent" disabled=${busy || (!allProjects && !selected.length)}>
          Approve
        </button>
      </div>
    </footer>
  </main>`;
}

function ProjectSetup({ api, orgs, hasProjects, busy, perform, refresh }) {
  const [orgId, setOrgId] = useState("");
  const createOrganization = (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get("name") || "");
    void perform(async () => {
      const org = await api.createOrg(name);
      setOrgId(org.id);
      form.reset();
      await refresh();
    });
  };
  const createProject = (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void perform(async () => {
      const project = await api.projects.create({
        project: String(data.get("name")),
        orgId: String(data.get("org")),
      });
      project[Symbol.dispose]?.(); // the new project's context stub is not what this page keeps
      form.reset();
      await refresh();
    });
  };
  return html`<details className="consent-create" open=${!hasProjects}>
    <summary>
      <h2>${orgs.length ? "Create a project or organization" : "Create your first organization"}</h2>
    </summary>
    <form onSubmit=${createOrganization}>
      <label>
        Organization name
        <input type="text" name="name" disabled=${busy} required />
      </label>
      <button type="submit" disabled=${busy}>Create organization</button>
    </form>
    ${
      orgs.length > 0 &&
      html`<form onSubmit=${createProject}>
      <label>
        Organization
        <select
          name="org"
          disabled=${busy}
          value=${orgId || orgs[0].id}
          onChange=${(event) => setOrgId(event.target.value)}
        >
          ${orgs.map((org) => html`<option key=${org.id} value=${org.id}>${org.name}</option>`)}
        </select>
      </label>
      <label>
        Project name
        <input type="text" name="name" disabled=${busy} required />
      </label>
      <button type="submit" disabled=${busy}>Create project</button>
    </form>`
    }
  </details>`;
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
}) {
  const names = new Map(orgs.map((org) => [org.id, org.name]));
  const selected = projects.filter((project) => !excluded.has(project.id));
  const toggle = (project) => (event) => {
    const checked = event.target.checked;
    setExcluded((current) => {
      const next = new Set(current);
      if (checked) next.delete(project.id);
      else next.add(project.id);
      return next;
    });
  };
  const groups = [...new Set(projects.map((project) => project.orgId))].map((orgId) => ({
    orgId,
    orgName: names.get(orgId) || orgId,
    group: projects.filter((project) => project.orgId === orgId),
  }));
  return html`<${"div"} className="consent-project-heading">
      <div>
        <h2>Projects</h2>
        <p className="muted" role="status">
          ${allProjects ? "All current and future projects" : `${selected.length} selected`}
        </p>
      </div>
      ${
        projects.length > 1 &&
        html`<div>
        <button
          className="consent-quiet"
          type="button"
          disabled=${busy || allProjects}
          onClick=${() => setExcluded(new Set())}
        >
          Select all
        </button>
        <button
          className="consent-quiet"
          type="button"
          disabled=${busy || allProjects}
          onClick=${() => setExcluded(new Set(projects.map((project) => project.id)))}
        >
          Clear
        </button>
      </div>`
      }
    <//>
    <fieldset className="consent-projects" aria-label="Projects it may reach" disabled=${busy || allProjects}>
      ${
        projects.length
          ? groups.map(
              ({
                orgId,
                orgName,
                group,
              }) => html`<section className="consent-org" key=${orgId} aria-label=${orgName}>
              <h3>
                ${orgName}
                <span className="muted">${group.length} ${group.length === 1 ? "project" : "projects"}</span>
              </h3>
              ${group.map(
                (project) => html`<label className="consent-project" key=${project.id}>
                  <input
                    type="checkbox"
                    name="project"
                    value=${project.id}
                    aria-label=${`${project.id} in ${orgName}`}
                    checked=${allProjects || !excluded.has(project.id)}
                    onChange=${toggle(project)}
                  />
                  <strong>${project.id}</strong>
                </label>`,
              )}
            </section>`,
            )
          : html`<p className="muted">
            ${
              projectBound
                ? "You do not have access to this app’s project."
                : "Create your first organization and project below, then approve access."
            }
          </p>`
      }
    </fieldset>
    ${
      !projectBound &&
      projects.length > 0 &&
      html`<label className="consent-future">
      <input
        type="checkbox"
        checked=${allProjects}
        disabled=${busy}
        aria-label="All my current and future projects"
        onChange=${(event) => setAllProjects(event.target.checked)}
      />
      <span>
        <strong>All my current and future projects</strong>
        <span className="muted">Include projects you create or join later.</span>
      </span>
    </label>`
    }
    <p className="muted">This app can read and make changes in the projects you grant it.</p>`;
}

const root = createRoot(document.getElementById("root"));
connect().then(
  (api) => root.render(html`<${AuthorizePage} api=${api} />`),
  (caught) =>
    root.render(html`<main>
      <h1>Iterate is unavailable</h1>
      <p role="alert">${message(caught)}</p>
    </main>`),
);
