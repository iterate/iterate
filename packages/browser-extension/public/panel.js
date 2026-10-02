// panel.js — the whole extension, after packages/spa/public/app.js: a sign-in through Chrome's identity
// window, then ONE WebSocket to the platform's /api opened bare, the credential presented IN the
// `authenticate` call, and this Chrome lent to the project's root context as `itx.chrome` — a live
// RpcTarget (open a page, raw CDP on the tabs the project may drive) that the project's agents and
// workers call back into while the panel is open. capnweb.js (the package's own browser bundle) and
// oauth.js (the SPA's) are copied beside this file by the build (README).
import { newWebSocketRpcSession, RpcTarget } from "./capnweb.js";
import { oauthClient } from "./oauth.js";

// ── Signing in: the SPA's oauth.js, through Chrome's identity window, everything kept in
// chrome.storage.local until sign-out.

/** chrome.storage.local as oauth.js's store. */
const chromeStore = {
  get: async (key) => (await chrome.storage.local.get(key))[key],
  set: (key, value) => chrome.storage.local.set({ [key]: value }),
  remove: (key) => chrome.storage.local.remove(key),
};

const oauth = oauthClient({
  sessions: chromeStore,
  // `https://<extension id>.chromiumapp.org/`: the published zip's manifest `key` keeps the id, and so
  // this URL, the same on every install (scripts/build.ts replaces manifest.json's placeholder).
  redirectUri: chrome.identity.getRedirectURL(),
  // the issuer's own login and consent pages, which share the profile's cookies
  launch: async (url) => {
    const callback = await chrome.identity.launchWebAuthFlow({ interactive: true, url });
    if (!callback) throw new Error("The sign-in window closed before the issuer sent Chrome back.");
    return callback;
  },
  registration: {
    client_name: "iterate Chrome extension",
    client_uri: "https://iterate.com",
    logo_uri: "https://os.iterate.com/client-logos/browser-extension.svg",
  },
});

// ── What this Chrome lends: an RpcTarget (capnweb passes it by reference, so a call on the project's
// root context runs HERE). The project drives the tabs it opened and the tabs the person lent it,
// over raw CDP, commands only: the wire stays a wire, and the browser's FACTS — a tab attached,
// navigated, detached — go to the root stream as ephemeral events.

/** The tabs the project may drive — opened by it, or lent by the person — each with whether the
 *  debugger is attached and, while it is being attached, that promise (so overlapping first calls
 *  share one attach). */
const tabs = new Map();
const grant = (tabId) =>
  tabs.get(tabId) ?? tabs.set(tabId, { attached: false, attaching: null }).get(tabId);

/** Let every tab go: on sign-out, and when the panel moves to another project. An attach still in
 *  flight settles first, so it cannot leave the debugger on a tab nobody tracks any more. */
async function releaseTabs() {
  for (const [tabId, known] of tabs) {
    await known.attaching?.catch(() => undefined);
    if (known.attached) await chrome.debugger.detach({ tabId }).catch(console.error);
  }
  tabs.clear();
}
/** Where the browser's facts go: the connected root context's append, set by `connect`. */
let report = () => {};
const fact = (type, payload) => report({ type, ephemeral: true, payload });

/** Attach the debugger to a tab the project may drive (once; Chrome shows its bar on the tab). */
async function attach(tabId) {
  const known = tabs.get(tabId);
  if (!known) throw new Error(`Tab ${tabId} is not one this project opened or was lent.`);
  if (known.attached) return;
  known.attaching ??= (async () => {
    await chrome.debugger.attach({ tabId }, "1.3");
    known.attached = true;
    await chrome.debugger.sendCommand({ tabId }, "Page.enable"); // main-frame navigations, below
    const { result } = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: "location.href",
      returnByValue: true,
    });
    fact("events.iterate.com/chrome/attached", { tabId, url: result.value });
  })().finally(() => {
    known.attaching = null;
  });
  await known.attaching;
}

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  if (method === "Page.frameNavigated" && !params.frame.parentId)
    fact("events.iterate.com/chrome/navigated", { tabId, url: params.frame.url });
});
chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  const known = tabs.get(tabId);
  if (known) known.attached = false;
  fact("events.iterate.com/chrome/detached", { tabId, reason });
});

class ChromeBrowser extends RpcTarget {
  /** The tabs the project may drive, still open: how an agent finds a tab the person lent. The
   *  `chrome/attached` event says the same, but only while the root context stays awake. */
  async tabs() {
    // The debugger's target list, not chrome.tabs: it carries each tab's URL and title without the
    // `tabs` permission.
    const targets = await chrome.debugger.getTargets();
    return targets
      .filter((target) => target.tabId !== undefined && tabs.has(target.tabId))
      .map(({ tabId, url, title }) => ({ tabId, url, title, attached: tabs.get(tabId).attached }));
  }

  /** Open an http(s) page in a new active tab the project may drive; answers once the page has
   *  loaded (or after ten seconds) with the tab's id and URL. */
  async openPage(input) {
    if (!input || typeof input.url !== "string") throw new Error("openPage() takes { url }.");
    const target = new URL(input.url);
    if (target.protocol !== "http:" && target.protocol !== "https:")
      throw new Error("openPage() only accepts http and https URLs.");
    const tab = await chrome.tabs.create({ active: true, url: target.href });
    grant(tab.id);
    await new Promise((loaded) => {
      const onUpdated = (tabId, change) => {
        if (tabId !== tab.id || change.status !== "complete") return;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        loaded();
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
      // Listener first, then the current status: a page that was already complete fires nothing.
      void chrome.tabs.get(tab.id).then((current) => onUpdated(tab.id, { status: current.status }));
      setTimeout(() => onUpdated(tab.id, { status: "complete" }), 10_000);
    });
    return { tabId: tab.id, url: target.href };
  }

  /** One CDP command on a tab the project may drive (attached on first use): the command's result,
   *  e.g. `cdp(tabId, "Runtime.evaluate", { expression: "document.title", returnByValue: true })`. */
  async cdp(tabId, method, params) {
    await attach(tabId);
    return chrome.debugger.sendCommand({ tabId }, method, params);
  }

  /** Let go of a tab: the debugger bar goes; the tab stays open and stays drivable later. */
  async detach(tabId) {
    if (tabs.get(tabId)?.attached) await chrome.debugger.detach({ tabId });
  }
}

// ── The panel.

/** Which platform and which project — remembered across panel openings. */
async function settings() {
  const stored = await chrome.storage.local.get(["issuer", "project"]);
  return { issuer: stored.issuer || "https://os.iterate.com", project: stored.project || "" };
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
    <h1>Iterate <small class="muted">v${escape(chrome.runtime.getManifest().version)}</small></h1>
    <p class="muted">Sign in at an iterate platform and pick a project: this Chrome becomes that
    project's <code>itx.chrome</code>.</p>
    <label>Platform <input id="issuer" value="${escape(issuer)}" spellcheck="false" /></label>
    <p><button id="login">Sign in with Iterate</button></p>`;
  const input = element("issuer", HTMLInputElement);
  element("login", HTMLButtonElement).onclick = async () => {
    const chosen = input.value.trim().replace(/\/$/, "");
    await chrome.storage.local.set({ issuer: chosen });
    try {
      await signedIn(await oauth.signIn(chosen));
    } catch (error) {
      fail(app, error);
    }
  };
}

async function signedIn(session) {
  const { project } = await settings();
  app.innerHTML = `
    <header>
      <h1>Iterate <small class="muted">v${escape(chrome.runtime.getManifest().version)}</small></h1>
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
    await releaseTabs();
    await oauth.signOut();
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
  // Another project must not inherit this one's tabs (a reconnect to the same project keeps them).
  if (project !== connectedProject) await releaseTabs();
  connectedProject = project;
  const view = element("connection", HTMLElement);
  view.innerHTML = project ? `<p class="muted">Connecting…</p>` : "";
  if (!project) return;

  const socket = new WebSocket(`${session.issuer.replace(/^http/, "ws")}/api`);
  const iterate = newWebSocketRpcSession(socket);
  live = iterate;
  try {
    const token = await oauth.freshAccessToken();
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
    report = (event) => itx.append(event).catch(console.error);
    const proofUrl = `https://example.com/?iterate-chrome-proof=${encodeURIComponent(whoami.projectId)}`;
    view.innerHTML = `
      <p>Connected as <strong>${escape(info.principal.email || info.principal.actor)}</strong>,
      project <code>${escape(whoami.projectId)}</code>.</p>
      <div class="capability">
        <div class="status"><span>Chrome capability</span><span>lent as <code>itx.chrome</code></span></div>
        <p><button id="prove">Open a page through the project</button>
          <button id="lend" class="secondary">Lend the current tab</button></p>
        <p id="proof-result" class="muted"></p>
        <p class="muted">Or post this to one of the project's agents:</p>
        <p class="prompt">Call itx.cd('/').chrome.openPage({ url: "${escape(proofUrl)}" }), then
          itx.cd('/').chrome.cdp(tabId, "Runtime.evaluate", { expression: "document.title", returnByValue: true })
          on the tabId it returned, and report the title.</p>
      </div>`;
    const result = element("proof-result", HTMLElement);
    element("prove", HTMLButtonElement).onclick = async () => {
      result.textContent = "Calling…";
      try {
        // The round trip: these calls leave for the platform, whose rule resolves `itx.chrome` to
        // the stub lent above and calls back into this very panel.
        const opened = await itx.invoke(["itx", "chrome", ["openPage", { url: proofUrl }]]);
        const evaluated = await itx.invoke([
          "itx",
          "chrome",
          [
            "cdp",
            opened.tabId,
            "Runtime.evaluate",
            { expression: "document.title", returnByValue: true },
          ],
        ]);
        result.textContent = `The project opened tab ${opened.tabId} and read its title: ${JSON.stringify(evaluated.result.value)}`;
      } catch (error) {
        result.textContent = "";
        fail(result, error);
      }
    };
    element("lend", HTMLButtonElement).onclick = async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) return;
      grant(tab.id);
      try {
        await attach(tab.id);
        result.textContent = `Tab ${tab.id} is lent: the project may drive it with cdp(${tab.id}, …).`;
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
  const [session, { issuer }] = await Promise.all([oauth.session(), settings()]);
  if (session) await signedIn(session);
  else await signedOut(issuer);
} catch (error) {
  fail(app, error);
}
