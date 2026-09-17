// app.js — the whole app. Static files on any host; the OAuth dance in oauth.js; then ONE
// WebSocket to the platform's /api, opened bare, and the credential presented IN the
// `authenticate` call (capnweb's own pattern): the session it returns is pipelined, so the first
// calls ride the same round trip as the token.
import { newWebSocketRpcSession } from "@iterate-com/capnweb";
import { beginLogin, currentSession, finishLogin, freshAccessToken, logout } from "./oauth.js";

// Which platform: `?issuer=http://localhost:8797` for a local os-next, remembered; else production.
const issuer =
  new URL(location.href).searchParams.get("issuer") ||
  localStorage.getItem("iterate-spa:issuer") ||
  "https://os.iterate2.com";
localStorage.setItem("iterate-spa:issuer", issuer);

const app = document.getElementById("app");
const escape = (text) =>
  String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

function signedOut() {
  app.innerHTML = `
    <h1>Iterate, from a static page</h1>
    <p>This page is plain files served from <code>${escape(location.origin)}</code>. It signs you in
    at <code>${escape(issuer)}</code> itself, then talks to <code>${escape(issuer)}/api</code> directly.</p>
    <p><button id="login">Sign in with Iterate</button></p>`;
  document.getElementById("login").onclick = () => beginLogin(issuer).catch(fail);
}

function fail(error) {
  console.error(error);
  const alert = document.createElement("p");
  alert.setAttribute("role", "alert");
  alert.textContent = error.message || String(error);
  app.append(alert);
}

async function signedIn(session) {
  const token = await freshAccessToken(session);
  const socket = new WebSocket(`${issuer.replace(/^http/, "ws")}/api`);
  const iterate = newWebSocketRpcSession(socket);
  const api = iterate.authenticate({ type: "bearer", token });
  const [info, projects] = await Promise.all([api.info(), api.projects.list()]);
  app.innerHTML = `
    <h1>Hello, ${escape(info.principal.email || info.principal.actor)}</h1>
    <p class="muted">Signed in from <code>${escape(location.origin)}</code>, connected to
    <code>${escape(issuer)}/api</code> over one WebSocket; the token went in the
    <code>authenticate</code> call.</p>
    <h2>Your projects</h2>
    <ul id="projects">${projects
      .map(
        (project) => `<li><code>${escape(project.id)}</code>
          <button data-project="${escape(project.id)}" data-action="whoami">whoami</button>
          <button data-project="${escape(project.id)}" data-action="count">count +1</button>
          <span data-result="${escape(project.id)}" class="muted"></span></li>`,
      )
      .join("")}</ul>
    ${projects.length ? "" : '<p class="muted">No projects reach this session yet.</p>'}
    <p><button id="logout">Sign out</button></p>`;
  document.getElementById("projects").onclick = async (event) => {
    const button = event.target.closest("button[data-project]");
    if (!button) return;
    const { project, action } = button.dataset;
    const result = app.querySelector(`[data-result="${CSS.escape(project)}"]`);
    try {
      using itx = await api.projects.get(project);
      if (action === "whoami") {
        result.textContent = JSON.stringify(await itx.whoami());
      } else {
        const next = Number((await itx.kv.get("spa-counter")) || 0) + 1;
        await itx.kv.put("spa-counter", String(next));
        result.textContent = `spa-counter = ${next}`;
      }
    } catch (error) {
      result.textContent = `error: ${error.message}`;
    }
  };
  document.getElementById("logout").onclick = async () => {
    try {
      await api.logout();
    } finally {
      logout();
      iterate[Symbol.dispose]();
      signedOut();
    }
  };
  socket.addEventListener("close", () => {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent =
      "The connection closed (the token expired or the grant was revoked). Reload.";
    app.append(note);
  });
}

try {
  const session = (await finishLogin()) || currentSession();
  if (session && session.issuer === issuer) await signedIn(session);
  else signedOut();
} catch (error) {
  signedOut();
  fail(error);
}
