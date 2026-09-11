// docs.ts — a deliberately plain browser screen: one authenticated capnweb session, an optional
// live-state follow, and Y.Text edits that append only their local Yjs delta. The server owns the
// durable document lens; this page owns its editable local CRDT replica and pending/error UI.

import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import * as Y from "yjs";
import { z } from "zod";
import { parse } from "../context/expression.ts";
import type { Itx, UnauthenticatedSession } from "../generated/itx-types/index.d.ts";
import { connectLiveState, type LiveStateConnection } from "./live-state-client.ts";

declare const DOCS_PROCESSOR_SOURCE: string;
declare const DOCS_YJS_MODULE: string;

const DocsState = z.object({
  documents: z.record(z.string(), z.object({ update: z.string(), text: z.string() })),
});
const DocsSnapshot = z.object({ offset: z.number(), state: DocsState });
const DocsLiveSnapshot = z.object({ rev: z.number(), state: DocsState });
type DocsState = z.infer<typeof DocsState>;

const query = new URL(location.href).searchParams;
const root = document.querySelector<HTMLDivElement>("#docs");
if (!root) throw new Error("Docs root is missing");
root.innerHTML = `
  <style>
    :root { color: #1d1d1f; background: #f7f7f5; font: 15px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
    main { max-width: 900px; margin: 2rem auto; padding: 0 1rem; } h1 { margin: 0 0 .25rem; font-size: 1.35rem; }
    p, small { color: #626262; } label { display: grid; gap: .3rem; } input, textarea, button { font: inherit; }
    input, textarea { border: 1px solid #c9c9c5; border-radius: .35rem; padding: .55rem; background: white; }
    textarea { min-height: 22rem; resize: vertical; } button { padding: .5rem .7rem; border: 1px solid #999; border-radius: .35rem; background: white; cursor: pointer; }
    button:disabled { cursor: wait; opacity: .55; } .row { display: flex; flex-wrap: wrap; gap: .65rem; align-items: end; margin: 1rem 0; }
    .row > label { flex: 1 1 13rem; } output { display: block; white-space: pre-wrap; padding: .6rem; border-radius: .35rem; background: #eeece7; }
    .ok { color: #176b3a; } .error { color: #a52222; } a { color: #1458a6; }
  </style>
  <h1>Docs</h1>
  <p>Yjs edits append to the durable Docs processor; following state is optional and separate from the socket connection.</p>
  <div class="row">
    <label>Project <input id="project" /></label>
    <label>Document path <input id="path" /></label>
    <label>Repository <input id="repo" /></label>
  </div>
  <div class="row">
    <button id="connect" type="button">Connect authenticated /api</button>
    <button id="enable" type="button" disabled>Enable Docs</button>
    <button id="follow" type="button" disabled>Follow document</button>
    <button id="retry" type="button" disabled>Retry failed update</button>
    <button id="revert" type="button" disabled>Revert unsaved replica</button>
    <button id="save" type="button" disabled>Save, check, build & activate</button>
    <a href="/demo">live-state demo</a>
    <a href="/login">sign in</a>
  </div>
  <output id="connection">connection: disconnected</output>
  <output id="follow-status">follow: off</output>
  <output id="outcome">No operation has run.</output>
  <label style="margin-top:1rem">Document source <textarea id="editor" spellcheck="false" disabled></textarea></label>
`;

const project = root.querySelector<HTMLInputElement>("#project")!;
const path = root.querySelector<HTMLInputElement>("#path")!;
const repoPath = root.querySelector<HTMLInputElement>("#repo")!;
const editor = root.querySelector<HTMLTextAreaElement>("#editor")!;
const connection = root.querySelector<HTMLOutputElement>("#connection")!;
const followStatus = root.querySelector<HTMLOutputElement>("#follow-status")!;
const outcome = root.querySelector<HTMLOutputElement>("#outcome")!;
const connect = root.querySelector<HTMLButtonElement>("#connect")!;
const enable = root.querySelector<HTMLButtonElement>("#enable")!;
const follow = root.querySelector<HTMLButtonElement>("#follow")!;
const save = root.querySelector<HTMLButtonElement>("#save")!;
const retry = root.querySelector<HTMLButtonElement>("#retry")!;
const revert = root.querySelector<HTMLButtonElement>("#revert")!;

// URL parameters configure this local demo; assigning through DOM properties keeps them text, never HTML.
project.value = query.get("project") ?? "prj_docs";
path.value = query.get("path") ?? "/tasks.md";
repoPath.value = query.get("repo") ?? "/apps/docs";

let api: RpcStub<UnauthenticatedSession> | undefined;
let itx: RpcStub<Itx> | undefined;
let socket: WebSocket | undefined;
let live: LiveStateConnection<DocsState> | undefined;
let unsubscribeLive: (() => void) | undefined;
let ydoc = new Y.Doc();
let text = ydoc.getText("content");
let docsEnabled = false;
let failedUpdate:
  | { update: string; path: string; idempotencyKey: string; error: Error }
  | undefined;
let pendingAppend: Promise<void> | undefined;
let connectionGeneration = 0;

function observeText(): void {
  text.observe(() => {
    editor.value = text.toString();
  });
}
observeText();

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary);
}

function bytes(update: string): Uint8Array {
  return Uint8Array.from(atob(update), (character) => character.charCodeAt(0));
}

function report(message: string, error?: unknown): void {
  outcome.className = error ? "error" : "ok";
  outcome.textContent = error
    ? `${message}: ${error instanceof Error ? error.message : String(error)}`
    : message;
}

/** The public build/check contract deliberately sends plain diagnostics. Keep their useful source
 * location intact in the UI instead of turning every object into `[object Object]`. */
type CheckDiagnostics = Extract<
  Awaited<ReturnType<Itx["check"]>>,
  { status: "rejected" }
>["diagnostics"];
type BuildDiagnostics = Extract<
  Awaited<ReturnType<Itx["build"]>>,
  { status: "rejected" }
>["diagnostics"];
function formatDiagnostics(diagnostics: CheckDiagnostics | BuildDiagnostics): string {
  return diagnostics
    .map((diagnostic) => {
      if (typeof diagnostic === "string") return diagnostic;
      const location = diagnostic.file
        ? `${diagnostic.file}${
            diagnostic.line === undefined
              ? ""
              : `:${diagnostic.line}${diagnostic.column === undefined ? "" : `:${diagnostic.column}`}`
          }`
        : "";
      return `${location ? `${location} ` : ""}TS${diagnostic.code}: ${diagnostic.message}`;
    })
    .join("\n");
}

function setBusy(button: HTMLButtonElement, busy: boolean): void {
  button.disabled = busy;
  for (const control of [connect, enable, follow, retry, revert, save]) {
    if (control !== button && busy) control.disabled = true;
  }
  if (!busy) {
    connect.disabled = false;
    enable.disabled = !itx;
    follow.disabled = !itx;
    retry.disabled = !failedUpdate;
    revert.disabled = !failedUpdate;
    save.disabled = !itx || !docsEnabled || !!failedUpdate;
  }
}

function setDocumentPending(pending: boolean): void {
  editor.disabled = pending || !docsEnabled;
  project.disabled = pending;
  path.disabled = pending;
  repoPath.disabled = pending;
  if (pending) {
    connect.disabled = true;
    enable.disabled = true;
    follow.disabled = true;
    retry.disabled = true;
    revert.disabled = true;
    save.disabled = true;
  } else {
    setBusy(connect, false);
  }
}

function replaceReplica(update?: string): void {
  ydoc.destroy();
  ydoc = new Y.Doc();
  text = ydoc.getText("content");
  observeText();
  if (update) Y.applyUpdate(ydoc, bytes(update));
  editor.value = text.toString();
}

function discardFailedUpdate(): void {
  failedUpdate = undefined;
  retry.disabled = true;
  revert.disabled = true;
  if (itx && docsEnabled) save.disabled = false;
}

async function disposeConnection(): Promise<void> {
  connectionGeneration += 1;
  unsubscribeLive?.();
  unsubscribeLive = undefined;
  await live?.dispose();
  live = undefined;
  api?.[Symbol.dispose]();
  api = undefined;
  socket?.close();
  socket = undefined;
  itx = undefined;
  docsEnabled = false;
  editor.disabled = true;
}

function connectionLost(message: string, closingSocket?: WebSocket): void {
  connectionGeneration += 1;
  unsubscribeLive?.();
  unsubscribeLive = undefined;
  live = undefined;
  const disconnectedApi = api;
  api = undefined;
  itx = undefined;
  socket = undefined;
  docsEnabled = false;
  connection.className = "error";
  connection.textContent = `connection: ${message}`;
  editor.disabled = true;
  enable.disabled = true;
  follow.disabled = true;
  retry.disabled = true;
  revert.disabled = true;
  save.disabled = true;

  // A browser `error` does not guarantee a following `close`. Dispose capnweb and close the
  // socket we still own; do not catch unexpected cleanup failures and hide their diagnosis.
  try {
    disconnectedApi?.[Symbol.dispose]();
  } finally {
    closingSocket?.close();
  }
}

function resetProjectOrPath(): void {
  unsubscribeLive?.();
  unsubscribeLive = undefined;
  void live?.dispose();
  live = undefined;
  replaceReplica();
  discardFailedUpdate();
  docsEnabled = false;
  editor.disabled = true;
  followStatus.className = "";
  followStatus.textContent = "follow: off";
  if (itx) report("Configuration changed. Enable Docs to seed the new document.");
  setBusy(connect, false);
}

project.addEventListener("change", () => {
  void disposeConnection().then(resetProjectOrPath);
});
path.addEventListener("change", resetProjectOrPath);
addEventListener("pagehide", () => {
  unsubscribeLive?.();
  void live?.dispose();
  api?.[Symbol.dispose]();
});

connect.addEventListener("click", async () => {
  setBusy(connect, true);
  connection.textContent = "connection: connecting";
  try {
    await disposeConnection();
    const url = new URL("/api", location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const generation = connectionGeneration;
    const connectedSocket = new WebSocket(url);
    socket = connectedSocket;
    connectedSocket.addEventListener("error", () => {
      if (generation === connectionGeneration) connectionLost("socket error", connectedSocket);
    });
    connectedSocket.addEventListener("close", (event) => {
      if (generation !== connectionGeneration) return;
      const reason = event.reason ? `, reason=${JSON.stringify(event.reason.slice(0, 160))}` : "";
      connectionLost(
        `closed (code=${event.code}, wasClean=${event.wasClean}${reason})`,
        connectedSocket,
      );
    });
    api = newWebSocketRpcSession<UnauthenticatedSession>(connectedSocket);
    const session = api.authenticate();
    itx = session.projects.get(project.value);
    // Authenticate and resolve one real method before declaring the connection usable.
    await itx.whoami();
    const identity = await session.identity();
    connection.className = "ok";
    connection.textContent = identity
      ? `connection: unverified identity ${identity.email}`
      : `connection: connected to anonymous demo (${project.value})`;
    report("Connected. Enable Docs before sending updates.");
  } catch (error) {
    connection.className = "error";
    connection.textContent = "connection: failed";
    report("Connection failed", error);
    await disposeConnection();
  } finally {
    setBusy(connect, false);
  }
});

enable.addEventListener("click", async () => {
  if (!itx) return;
  setBusy(enable, true);
  try {
    await itx.enableProcessor("docs", {
      source: { "cap.js": DOCS_PROCESSOR_SOURCE, "yjs.js": DOCS_YJS_MODULE },
      className: "DocsDurableObject",
      consumes: ["docs/update"],
    });
    const snapshot = DocsSnapshot.parse(await itx.invoke("itx.facets.get('docs').snapshot()"));
    replaceReplica(snapshot.state.documents[path.value]?.update);
    docsEnabled = true;
    editor.disabled = false;
    report("Docs processor enabled; follow is still off until requested.");
  } catch (error) {
    report("Enable Docs failed", error);
  } finally {
    setBusy(enable, false);
  }
});

follow.addEventListener("click", async () => {
  if (!itx) return;
  setBusy(follow, true);
  try {
    unsubscribeLive?.();
    unsubscribeLive = undefined;
    await live?.dispose();
    live = undefined;
    const scope = itx;
    live = await connectLiveState<DocsState>(scope, {
      key: "docs",
      name: `docs-browser-${crypto.randomUUID()}`,
      door: async () =>
        DocsLiveSnapshot.parse(await scope.invoke("itx.facets.get('docs').liveSnapshot()")),
    });
    const apply = () => {
      const documentState = live?.store.get()?.documents[path.value];
      if (documentState) Y.applyUpdate(ydoc, bytes(documentState.update));
    };
    unsubscribeLive = live.store.subscribe(apply);
    apply();
    followStatus.className = "ok";
    followStatus.textContent = `follow: live (${path.value})`;
    report("Following the server projection; remote updates only merge into Y.Text.");
  } catch (error) {
    followStatus.className = "error";
    followStatus.textContent = "follow: failed";
    report("Follow failed", error);
  } finally {
    setBusy(follow, false);
  }
});

editor.addEventListener("input", () => {
  if (!itx || !docsEnabled) return;
  const before = Y.encodeStateVector(ydoc);
  const previous = text.toString();
  const next = editor.value;
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start])
    start += 1;
  let end = 0;
  while (
    end < previous.length - start &&
    end < next.length - start &&
    previous[previous.length - 1 - end] === next[next.length - 1 - end]
  )
    end += 1;
  ydoc.transact(() => {
    if (previous.length - start - end) text.delete(start, previous.length - start - end);
    if (next.length - start - end) text.insert(start, next.slice(start, next.length - end));
  });
  const update = base64(Y.encodeStateAsUpdate(ydoc, before));
  const scope = itx;
  const documentPath = path.value;
  const generation = connectionGeneration;
  outcome.className = "";
  outcome.textContent = "Sending local Yjs delta…";
  const idempotencyKey = crypto.randomUUID();
  setDocumentPending(true);
  const append = scope
    .invoke([
      "itx",
      [
        "append",
        {
          type: "docs/update",
          idempotencyKey,
          payload: { path: documentPath, update },
        },
      ],
    ])
    .then(() => {
      if (generation !== connectionGeneration) return;
      report("Document update committed; follow applies the materialized server state.");
    })
    .catch((caught: unknown) => {
      if (generation !== connectionGeneration) return;
      const error = caught instanceof Error ? caught : new Error(String(caught));
      failedUpdate = { update, path: documentPath, idempotencyKey, error };
      retry.disabled = false;
      revert.disabled = false;
      save.disabled = true;
      report("Document update failed; retry or revert before publishing", error);
    })
    .finally(() => {
      if (generation !== connectionGeneration || failedUpdate) return;
      setDocumentPending(false);
    });
  pendingAppend = append;
  void append.finally(() => {
    if (pendingAppend === append) pendingAppend = undefined;
  });
});

retry.addEventListener("click", async () => {
  if (!itx || !failedUpdate) return;
  setBusy(retry, true);
  const failed = failedUpdate;
  const generation = connectionGeneration;
  try {
    await itx.invoke([
      "itx",
      [
        "append",
        {
          type: "docs/update",
          idempotencyKey: failed.idempotencyKey,
          payload: { path: failed.path, update: failed.update },
        },
      ],
    ]);
    if (generation !== connectionGeneration) return;
    discardFailedUpdate();
    setDocumentPending(false);
    report("The failed Yjs delta committed on retry.");
  } catch (caught) {
    if (generation !== connectionGeneration) return;
    const error = caught instanceof Error ? caught : new Error(String(caught));
    failedUpdate = { ...failed, error };
    report("Retry failed", error);
  } finally {
    setBusy(retry, false);
  }
});

revert.addEventListener("click", async () => {
  if (!itx) return;
  const scope = itx;
  setBusy(revert, true);
  try {
    const snapshot = DocsSnapshot.parse(await scope.invoke("itx.facets.get('docs').snapshot()"));
    if (scope !== itx) return;
    replaceReplica(snapshot.state.documents[path.value]?.update);
    discardFailedUpdate();
    setDocumentPending(false);
    report("Reverted the local replica to the current server snapshot.");
  } catch (error) {
    report("Revert failed", error);
  } finally {
    setBusy(revert, false);
  }
});

save.addEventListener("click", async () => {
  if (!itx || !docsEnabled) return;
  setBusy(save, true);
  try {
    await pendingAppend;
    if (failedUpdate) throw failedUpdate.error;
    const documentSource = text.toString();
    const appSource = `import { WorkerEntrypoint } from "cloudflare:workers";
import { document } from "./document";
export default class DocsApp extends WorkerEntrypoint {
  fetch() { return new Response(document, { headers: { "content-type": "text/markdown" } }); }
}`;
    const repo = itx.repos.get(repoPath.value);
    const head = await repo.head();
    const revision = await repo.commit({
      parent: head?.revision ?? null,
      message: `publish ${path.value}`,
      files: {
        "src/main.ts": appSource,
        "src/document.ts": `export const document = ${JSON.stringify(documentSource)};`,
      },
    });
    const source = {
      source: { repo: repoPath.value, revision: revision.revision },
      options: { entryPoint: "src/main.ts" },
    };
    const checked = await itx.check(source);
    if (checked.status !== "checked")
      throw new Error(`Check rejected:\n${formatDiagnostics(checked.diagnostics)}`);
    const built = await itx.build(source);
    if (built.status !== "built")
      throw new Error(`Build rejected:\n${formatDiagnostics(built.diagnostics)}`);
    const target = `itx.workers.load(${JSON.stringify(built.code)}, { cacheKey: ${JSON.stringify(built.key)} })`;
    parse(target); // Refuse an unparseable durable rule before its atomic append reaches the stream.
    await itx.invoke([
      "itx",
      [
        "append",
        {
          type: "events.iterate.com/docs/activated",
          idempotencyKey: crypto.randomUUID(),
          payload: {
            repo: repoPath.value,
            revision: revision.revision,
            buildKey: built.key,
            documentPath: path.value,
          },
        },
        {
          type: "events.iterate.com/itx/rewrite-rule-configured",
          idempotencyKey: crypto.randomUUID(),
          payload: { match: "itx.docs", target },
        },
      ],
    ]);
    const activated = new URL("/expression", location.href);
    activated.searchParams.set("context", project.value);
    activated.searchParams.set("itx", "itx.docs");
    const response = await fetch(activated);
    if (!response.ok || (await response.text()) !== documentSource)
      throw new Error("durable itx.docs activation did not serve the committed document");
    report(`Published ${revision.revision}, checked, built, and durably activated itx.docs.`);
  } catch (error) {
    report("Publish failed", error);
  } finally {
    setBusy(save, false);
  }
});
