// panel.js — the whole side panel, after apps/spa/public/app.js: the OAuth dance in oauth.js, then
// ONE WebSocket to the platform's /api opened bare, the credential presented IN the `authenticate`
// call, and this Chrome lent to the project's root context as `itx.chrome` — a live RpcTarget the
// project's agents and workers call back into for as long as the panel is open.
import { newWebSocketRpcSession } from "./capnweb.js";
import { ChromeBrowser } from "./chrome-browser.js";
import { currentSession, freshAccessToken, signIn, signOut } from "./oauth.js";

/** Which platform and which project — remembered across panel openings. */
async function settings() {
  const stored = await chrome.storage.local.get(["issuer", "project"]);
  return { issuer: stored.issuer || "https://os.iterate2.com", project: stored.project || "" };
}

/** An element the page holds, by id and kind — the templates below always render it. */
function element(id, kind) {
  const found = document.getElementById(id);
  if (found instanceof kind) return found;
  throw new Error(`The panel rendered no ${kind.name} #${id}.`);
}

const app = element("app", HTMLElement);
const escape = (text) =>
  String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

function fail(into, error) {
  console.error(error);
  const alert = document.createElement("p");
  alert.setAttribute("role", "alert");
  alert.className = "error";
  alert.textContent = error instanceof Error ? error.message : String(error);
  into.append(alert);
}

// A view or a connection that is no longer current stops acting: every async step compares its
// generation to this counter before touching the page or the socket.
let generation = 0;
let live = null;
let liveApi = null;
let connectedProject = "";

async function signedOut(issuer) {
  generation += 1;
  live?.[Symbol.dispose]();
  live = null;
  app.innerHTML = `
    <h1>Iterate</h1>
    <p class="muted">Sign in at an iterate platform and pick a project: this Chrome becomes that
    project's <code>itx.chrome</code>.</p>
    <label>Platform <input id="issuer" value="${escape(issuer)}" spellcheck="false" /></label>
    <p><button id="login">Sign in with Iterate</button></p>`;
  const input = element("issuer", HTMLInputElement);
  element("login", HTMLButtonElement).onclick = async () => {
    const chosen = input.value.trim().replace(/\/$/, "");
    await chrome.storage.local.set({ issuer: chosen });
    try {
      await signedIn(await signIn(chosen));
    } catch (error) {
      fail(app, error);
    }
  };
}

async function signedIn(session) {
  const { project } = await settings();
  app.innerHTML = `
    <header>
      <h1>Iterate</h1>
      <button id="logout" class="secondary">Sign out</button>
    </header>
    <p class="muted">Signed in at <code>${escape(session.issuer)}</code>.</p>
    <label>Project
      <input id="project" value="${escape(project)}" placeholder="slug or prj_… id" spellcheck="false" />
    </label>
    <section id="connection"></section>`;
  element("logout", HTMLButtonElement).onclick = async () => {
    // End the grant on the platform too, when connected; the tokens go regardless.
    try {
      await liveApi?.logout();
    } catch (error) {
      console.error(error);
    }
    await signOut();
    await signedOut(session.issuer);
  };
  const input = element("project", HTMLInputElement);
  input.onchange = async () => {
    const chosen = input.value.trim();
    // A change event that names the connected project again (Enter, then a click elsewhere) must
    // not tear the live lend down to make the same one.
    if (chosen === connectedProject) return;
    await chrome.storage.local.set({ project: chosen });
    await connect(session, chosen);
  };
  await connect(session, project);
}

/** One socket, one lend. When the platform closes the socket (the hour-old access token expired,
 *  the grant ended) the panel connects again — a fresh token is a fresh socket, and the lend goes
 *  with the socket, so it is made again too. */
async function connect(session, project) {
  const mine = ++generation;
  live?.[Symbol.dispose]();
  live = null;
  liveApi = null;
  connectedProject = project;
  const view = element("connection", HTMLElement);
  view.innerHTML = project ? `<p class="muted">Connecting…</p>` : "";
  if (!project) return;

  const socket = new WebSocket(`${session.issuer.replace(/^http/, "ws")}/api`);
  const iterate = newWebSocketRpcSession(socket);
  live = iterate;
  try {
    const token = await freshAccessToken(session);
    // capnweb answers `authenticate` with a pipelined stub of the session: the calls below ride the
    // same round trip as the token.
    const api = iterate.authenticate({ type: "bearer", token });
    const itx = await api.projects.get(project);
    // The lend is a rewrite rule of THIS context — the project's root, `/` — so a caller in another
    // context of the project (an agent's script runs in its own) spells it `itx.cd('/').chrome`.
    const [info, whoami] = await Promise.all([
      api.info(),
      itx.whoami(),
      itx.provide("itx.chrome", new ChromeBrowser()),
    ]);
    if (mine !== generation) return;
    liveApi = api;
    const proofUrl = `https://example.com/?iterate-chrome-proof=${encodeURIComponent(whoami.projectId)}`;
    view.innerHTML = `
      <p>Connected as <strong>${escape(info.principal.email || info.principal.actor)}</strong>,
      project <code>${escape(whoami.projectId)}</code>.</p>
      <div class="capability">
        <div class="status"><span>Chrome capability</span><span>lent as <code>itx.chrome</code></span></div>
        <p><button id="prove">Open a page through the project</button></p>
        <p id="proof-result" class="muted"></p>
        <div class="proof">
          <span>Or post this to one of the project's agents</span>
          <p>Call itx.cd('/').chrome.openPage({ url: "${escape(proofUrl)}" }) and report the tabId and url it returns.</p>
        </div>
      </div>`;
    element("prove", HTMLButtonElement).onclick = async () => {
      const result = element("proof-result", HTMLElement);
      result.textContent = "Calling…";
      try {
        // The round trip: this call leaves for the platform, whose rule resolves `itx.chrome` to the
        // stub lent above and calls back into this very panel.
        const opened = await itx.invoke(["itx", "chrome", ["openPage", { url: proofUrl }]]);
        result.textContent = `The project answered ${JSON.stringify(opened)}`;
      } catch (error) {
        result.textContent = "";
        fail(result, error);
      }
    };
  } catch (error) {
    if (mine !== generation) return;
    view.innerHTML = `<p><button id="retry" class="secondary">Retry</button></p>`;
    fail(view, error);
    element("retry", HTMLButtonElement).onclick = () => connect(session, project);
    return;
  }
  socket.addEventListener("close", () => {
    if (mine !== generation) return;
    view.innerHTML = `<p class="muted">The connection closed; connecting again…</p>`;
    setTimeout(() => {
      if (mine === generation) void connect(session, project);
    }, 2_000);
  });
}

try {
  const [session, { issuer }] = await Promise.all([currentSession(), settings()]);
  if (session) await signedIn(session);
  else await signedOut(issuer);
} catch (error) {
  fail(app, error);
}
