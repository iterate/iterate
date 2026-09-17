// The fixed issuer shell: the OAuth AS's bindings, the sign-in door, and THE ISSUER'S TWO PAGES —
// /login and the /authorize consent — both HTML the worker renders whole, no framework, no build, no
// static assets: the consent page is one form whose buttons name their action, and the session that
// answers it is built here the way /api builds it. Everything else a person does with Iterate is an
// app's — an ordinary OAuth client of this issuer (the dash, on its own origin, first among them).
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import {
  codedError,
  errorCode,
  isSameOriginBrowserRequest,
  sameOriginPath,
} from "iterate/next/lib";
import { verifyAdminSecret } from "iterate/next/principal";
import type { BrowserSession } from "iterate/next/app-session";
import { startIssuerSession } from "./issuer-session.ts";
import { directory } from "./directory.ts";
import { appConfigOf } from "./app-config.ts";
import { browserAuthorization } from "./browser-client.ts";
import { Consent, type ConsentView } from "./consent.ts";
import { Grants } from "./grants.ts";
import { ISSUER_CSS } from "./issuer-css.ts";
import { IterateRpcTarget, SessionTeardown, type SessionRpcTarget } from "./session.ts";
import type { Env as DurableObjectEnv } from "./iterate-context-durable-object.ts";

/** Platform bindings for the issuer, public APIs and project ingress. */
export interface Env extends DurableObjectEnv {
  BROWSER_SESSION: DurableObjectNamespace<BrowserSession>;
  /** Provider-owned store: grants, tokens, DCR clients. Required by @cloudflare/workers-oauth-provider. */
  OAUTH_KV: KVNamespace;
  /** The directory: users, orgs, org_members, projects (control-plane.sql). Strongly consistent (D1). */
  DB: D1Database;
  /** Injected by the provider — the OAuth helper surface (parseAuthRequest / completeAuthorization / …). */
  OAUTH_PROVIDER: OAuthHelpers;
}

/** A worker handler with a REQUIRED fetch — what OAuthProvider expects for defaultHandler/apiHandler. */
export interface Handler {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
}

/** Email-only sign-in for explicitly enabled test deployments and localhost,
 * or the administrator fixture. Other deployments require verified Google identity. */
export async function signIn(
  env: Env,
  request: Request,
  input: { email: string; next: string },
): Promise<{ setCookie: string; location: string }> {
  const config = appConfigOf(env);
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (
    !config.testEmailLogin &&
    !(bearer && (await verifyAdminSecret(bearer, config.adminApiSecret.exposeSecret())))
  )
    throw codedError("UNAUTHENTICATED", "Sign in with Google.");
  const email = input.email.trim();
  if (!email) throw codedError("INVALID_INPUT", "Enter an email.");
  const user = await directory(env.DB).upsertUser(email);
  return startIssuerSession(env, user, input.next);
}

// ── the issuer's pages ──

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

/** One issuer document: the stylesheet inlined (the platform serves HTML strings and nothing else —
 *  no static assets), `body` as given, and the one script a page may carry, placed after the body
 *  it wires up. A per-response nonce admits exactly that style and that script; the CSP names
 *  nothing else. */
function issuerDocument(body: string, script?: string): Response {
  const nonce = crypto.randomUUID();
  return new Response(
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Iterate</title><style nonce="${nonce}">${ISSUER_CSS}</style><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 32 32%27%3E%3Crect width=%2732%27 height=%2732%27 rx=%278%27 fill=%27%23111%27/%3E%3Cpath d=%27M16 8v16%27 stroke=%27white%27 stroke-width=%274%27/%3E%3C/svg%3E"></head><body>${body}${script ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>\n`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "Content-Security-Policy": [
          "default-src 'none'",
          `style-src 'nonce-${nonce}'`,
          `script-src 'nonce-${nonce}'`,
          "img-src data:",
          // no form-action: Chrome applies it to the redirect a submission ends in, and Approve ends
          // in the OAuth client's redirect_uri — any https origin, or loopback for a native client
          "base-uri 'none'",
          "frame-ancestors 'none'",
        ].join("; "),
        "X-Frame-Options": "DENY",
      },
    },
  );
}

/** /login, rendered whole — it needs the request (who is signed in, which sign-ins this deployment
 *  offers, where to continue) and nothing live. The email form posts back to `signInDoor`; Google
 *  is the identity door (identity.ts); "switch account" ends the browser's session and returns here. */
async function loginPage(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const config = appConfigOf(env);
  const next = sameOriginPath(
    new URL(request.url).searchParams.get("next") || "/",
    config.platformOrigin,
  );
  const session = await browserAuthorization(env, request, ctx);
  const google = Boolean(config.googleClientId && config.googleClientSecret.exposeSecret());
  const switchAccount = `/.auth/logout?next=${encodeURIComponent(`/login?next=${encodeURIComponent(next)}`)}`;
  const who = session && escapeHtml(session.principal.email || session.principal.actor);
  const body = session
    ? `<p>Signed in as <strong>${who}</strong>.</p>
<p><a href="${escapeHtml(next)}">Continue as ${who}</a></p>
<form method="post" action="${escapeHtml(switchAccount)}"><button type="submit">Switch account</button></form>`
    : [
        config.testEmailLogin &&
          `<form method="post" action="/login"><input type="hidden" name="next" value="${escapeHtml(next)}"><label>Email <input type="email" name="email" placeholder="you@example.com" required></label><button type="submit">Continue</button><p class="muted">Test sign-in: use any email. No verification.</p></form>`,
        google &&
          `<p><a href="/.auth/identity?next=${encodeURIComponent(next)}">Continue with Google</a></p>`,
        !config.testEmailLogin &&
          !google &&
          `<p>Sign-in is not configured for this deployment.</p>`,
      ]
        .filter(Boolean)
        .join("\n");
  return issuerDocument(`<main><h1>Sign in</h1>\n${body}\n</main>`);
}

/** The sign-in form's POST — a plain form, no script needed to sign in. */
async function signInDoor(request: Request, env: Env): Promise<Response | null> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/login") return null;
  const form = await request.formData();
  try {
    const { setCookie, location } = await signIn(env, request, {
      email: String(form.get("email") ?? ""),
      next: String(form.get("next") ?? "/"),
    });
    return new Response(null, { status: 302, headers: { location, "set-cookie": setCookie } });
  } catch (error) {
    const code = errorCode(error);
    if (!["UNAUTHENTICATED", "INVALID_INPUT"].includes(code || "")) throw error;
    return new Response(error instanceof Error ? error.message : String(error), {
      status: code === "UNAUTHENTICATED" ? 401 : 400,
    });
  }
}

// ── /authorize, the consent page: a form ──

/** The browser's session, built the way /api builds it (rpc.ts): the authorization the cookie
 *  resolved is the session's authority, and an issuer grant — a sign-in on this origin — carries the
 *  consent capability. Null when the browser holds no session. The teardown is the caller's to
 *  dispose once the response is built. */
async function browserSession(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<{ session: SessionRpcTarget; teardown: SessionTeardown } | null> {
  const authorization = await browserAuthorization(env, request, ctx);
  if (!authorization) return null;
  const teardown = new SessionTeardown();
  const root = new IterateRpcTarget(
    {
      contextNamespace: env.ITERATE_CONTEXT,
      waitUntil: (promise) => ctx.waitUntil(promise),
      directory: directory(env.DB),
      appConfig: appConfigOf(env),
    },
    teardown,
    {
      principal: authorization.principal,
      reach: authorization.reach,
      grants: new Grants(env, ctx, authorization),
      scopes: authorization.grant?.scope,
      ...(authorization.grant?.kind === "issuer" && {
        consent: new Consent(env, authorization.grant),
      }),
    },
  );
  return { session: await root.authenticate({ type: "from-server-cookie" }), teardown };
}

/** What the consent form remembers across its own posts: the projects the person unticked (a
 *  created project starts ticked; a refresh keeps every deselection), the "every project" box, the
 *  organization to preselect for the next project, and an error to show. */
type ConsentFormState = {
  excluded: Set<string>;
  allProjects: boolean;
  /** The create-an-organization-or-project section: open while there is no project, and kept open
   *  after a create unless that create made the first project (the moment the list appears). */
  setupOpen?: boolean;
  selectedOrgId?: string;
  error?: string;
};

/** The consent page, rendered from `consent.describe`'s answer and the form's state. Plain HTML: one
 *  form whose three submit buttons name the action; the script below only keeps the Approve button
 *  and the "N selected" line in step with the checkboxes while the person clicks. */
function consentPage(
  answer: Extract<ConsentView, { kind: "consent" }>,
  query: string,
  state: ConsentFormState,
): Response {
  const { clientName, email, projects, orgs, projectBound, scopes, denyLocation } = answer;
  const selected = projects.filter((project) => !excluded(project.id));
  function excluded(id: string) {
    return state.excluded.has(id);
  }
  const names = new Map(orgs.map((org) => [org.id, org.name]));
  const orgIds = [...new Set(projects.map((project) => project.orgId))];
  const loginAgain = `/login?next=${encodeURIComponent(`/authorize${query}`)}`;
  const action = escapeHtml(`/authorize${query}`);
  const projectRows = projects.length
    ? orgIds
        .map((orgId) => {
          const group = projects.filter((project) => project.orgId === orgId);
          const orgName = names.get(orgId) || orgId;
          return `<section class="consent-org" aria-label="${escapeHtml(orgName)}"><h3>${escapeHtml(orgName)}<span class="muted">${group.length} ${group.length === 1 ? "project" : "projects"}</span></h3>${group
            .map(
              (project) =>
                `<label class="consent-project"><input type="checkbox" name="project" value="${escapeHtml(project.id)}" aria-label="${escapeHtml(`${project.id} in ${orgName}`)}"${state.allProjects || !excluded(project.id) ? " checked" : ""}><strong>${escapeHtml(project.id)}</strong></label>`,
            )
            .join("")}</section>`;
        })
        .join("")
    : `<p class="muted">${projectBound ? "You do not have access to this app’s project." : "Create your first organization and project below, then approve access."}</p>`;
  const setup = projectBound
    ? ""
    : `<details class="consent-create"${state.setupOpen || !projects.length ? " open" : ""}><summary><h2>${orgs.length ? "Create a project or organization" : "Create your first organization"}</h2></summary>
<label>Organization name <input type="text" name="org-name"></label>
<button type="submit" name="action" value="create-org">Create organization</button>${
        orgs.length
          ? `
<label>Organization <select name="org">${orgs.map((org) => `<option value="${escapeHtml(org.id)}"${org.id === (state.selectedOrgId || orgs[0]!.id) ? " selected" : ""}>${escapeHtml(org.name)}</option>`).join("")}</select></label>
<label>Project name <input type="text" name="project-name"></label>
<button type="submit" name="action" value="create-project">Create project</button>`
          : ""
      }
</details>`;
  const body = `<main class="consent-card">
<header><div class="consent-app"><span class="consent-avatar" aria-hidden="true">${escapeHtml(clientName.slice(0, 2).toUpperCase())}</span><div><span class="consent-badge">Project access</span><h1>Authorize ${escapeHtml(clientName)}</h1></div></div>
<p class="muted">${projectBound ? "Review access to this app’s project." : "Choose which projects this app can use."}</p></header>
<section class="consent-account" aria-label="Signed-in account"><span class="consent-avatar" aria-hidden="true">${escapeHtml(email.slice(0, 1).toUpperCase())}</span><div><span class="muted">Signed in as</span><strong>${escapeHtml(email)}</strong></div>
<form method="post" action="${escapeHtml(`/.auth/logout?next=${encodeURIComponent(loginAgain)}`)}"><button class="consent-quiet" type="submit">Switch account</button></form></section>
<form id="consent" method="post" action="${action}">
${scopes.includes("account") ? `<p><strong>Account permission:</strong> this app can view and end all your sessions and create personal access tokens for the projects you grant it.</p>` : ""}
<div class="consent-project-heading"><div><h2>Projects</h2><p class="muted" role="status" data-selected>${state.allProjects ? "All current and future projects" : `${selected.length} selected`}</p></div>${
    projects.length > 1
      ? `<div><button class="consent-quiet" type="button" data-select="all">Select all</button><button class="consent-quiet" type="button" data-select="none">Clear</button></div>`
      : ""
  }</div>
<fieldset class="consent-projects" aria-label="Projects it may reach"${state.allProjects ? " disabled" : ""}>${projectRows}</fieldset>
${
  !projectBound && projects.length
    ? `<label class="consent-future"><input type="checkbox" name="all" value="1" aria-label="All my current and future projects"${state.allProjects ? " checked" : ""}><span><strong>All my current and future projects</strong><span class="muted">Include projects you create or join later.</span></span></label>`
    : ""
}
<p class="muted">This app can read and make changes in the projects you grant it.</p>
${setup}
<footer>${state.error ? `<p role="alert" data-type="error">${escapeHtml(state.error)}</p>` : ""}
<div class="consent-actions"><a href="${escapeHtml(denyLocation)}">Cancel</a><button type="submit" name="action" value="approve"${state.allProjects || selected.length ? "" : " disabled"}>Approve</button></div></footer>
</form>
</main>`;
  return issuerDocument(body, CONSENT_SCRIPT);
}

/** The whole client side of consent: the Approve button and the "N selected" line follow the
 *  checkboxes; "Select all" / "Clear" tick them; the "every project" box parks the list. */
const CONSENT_SCRIPT = `(() => {
  const form = document.getElementById("consent");
  if (!form) return;
  const boxes = () => Array.from(form.querySelectorAll('input[name="project"]'));
  const all = form.querySelector('input[name="all"]');
  const approve = form.querySelector('button[value="approve"]');
  const status = form.querySelector("[data-selected]");
  const list = form.querySelector("fieldset");
  let parked = null;
  const sync = () => {
    const every = Boolean(all && all.checked);
    if (every && !parked) {
      parked = boxes().map((box) => box.checked);
      for (const box of boxes()) box.checked = true;
    } else if (!every && parked) {
      boxes().forEach((box, i) => (box.checked = parked[i]));
      parked = null;
    }
    const ticked = boxes().filter((box) => box.checked).length;
    if (list) list.disabled = every;
    if (status) status.textContent = every ? "All current and future projects" : ticked + " selected";
    if (approve) approve.disabled = !every && ticked === 0;
  };
  form.addEventListener("change", sync);
  for (const button of form.querySelectorAll("[data-select]"))
    button.addEventListener("click", () => {
      for (const box of boxes()) box.checked = button.getAttribute("data-select") === "all";
      sync();
    });
  sync();
})();`;

/** GET /authorize renders the consent page for the signed-in browser; POST /authorize is one of its
 *  three buttons — approve, create an organization, create a project — the last two re-rendering the
 *  page with the directory refreshed and every deselection kept. No session ⇒ sign in first, and
 *  come back to this very URL. */
async function consentDoor(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const query = url.search;
  const browser = await browserSession(request, env, ctx);
  if (!browser)
    return new Response(null, {
      status: 303,
      headers: {
        Location: `/login?next=${encodeURIComponent(`/authorize${query}`)}`,
        "Cache-Control": "no-store",
      },
    });
  const { session, teardown } = browser;
  try {
    const describe = async () => {
      const answer = await session.consent.describe(query);
      return answer.kind === "redirect"
        ? new Response(null, { status: 302, headers: { Location: answer.location } })
        : answer.kind === "invalid"
          ? issuerDocument(
              `<main><h1>Invalid authorization request</h1><p>${escapeHtml(answer.description)}</p></main>`,
            )
          : answer;
    };
    const before = await describe();
    if (before instanceof Response) return before;
    if (request.method !== "POST")
      return consentPage(before, query, { excluded: new Set(), allProjects: false });
    const form = await request.formData();
    const posted = new Set(form.getAll("project").map(String));
    const action = form.get("action");
    const state: ConsentFormState = {
      // what the person unticked, judged against the list they saw — a project created below starts ticked
      excluded: new Set(before.projects.filter((p) => !posted.has(p.id)).map((p) => p.id)),
      allProjects: form.get("all") === "1",
      setupOpen: action !== "approve" && before.projects.length > 0,
    };
    try {
      if (action === "approve") {
        const result = await session.consent.approve({
          query,
          projects: state.allProjects ? ["*"] : [...posted],
        });
        if ("error" in result) throw new Error(result.error);
        return new Response(null, {
          status: 302,
          headers: { Location: result.redirectTo, "Cache-Control": "no-store" },
        });
      }
      if (action === "create-org") {
        const org = await session.createOrg(String(form.get("org-name") ?? ""));
        state.selectedOrgId = org.id;
      } else if (action === "create-project") {
        // the new project's context is the session's to hold; the teardown below lets it go
        await session.projects.create({
          project: String(form.get("project-name") ?? ""),
          orgId: String(form.get("org") ?? ""),
        });
        state.selectedOrgId = String(form.get("org") ?? "");
      } else throw new Error("Choose an action.");
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    }
    const after = await describe();
    if (after instanceof Response) return after;
    return consentPage(after, query, state);
  } finally {
    teardown.disposeAll();
  }
}

/** The issuer's pages: the sign-in door and page, the consent page and its form, with same-origin
 *  POST checks. Anything else on the platform origin is not a page — the dash lives on its own origin. */
export const issuerHandler: Handler = {
  async fetch(request, env, ctx) {
    if (request.method === "POST" && !isSameOriginBrowserRequest(request))
      return new Response("403: a cross-site request cannot act on this session\n", {
        status: 403,
      });
    const door = await signInDoor(request, env);
    if (door) return door;
    const { pathname } = new URL(request.url);
    if (!["GET", "HEAD", "POST"].includes(request.method))
      return new Response("Method not allowed", { status: 405 });
    if (pathname === "/authorize") return consentDoor(request, env, ctx);
    if (pathname === "/login" && request.method !== "POST") return loginPage(request, env, ctx);
    return new Response("Not found", { status: 404 });
  },
};
