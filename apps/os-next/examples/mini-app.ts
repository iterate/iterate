// examples/mini-app.ts — a SUPER-SIMPLE, no-build userspace mini-app for a clean-room project.
//
// The WHOLE app is ONE loaded WorkerEntrypoint. A project registers it with a single rewrite rule:
//
//   itx.provide("itx.apps.notes",
//     "itx.workers.get({ source: { 'cap.js': <this file, TS stripped> }, cacheKey: 'notes:v1' })")
//
// and it is reachable at  https://notes--<project>.<base>/  (deployed) or
//   http://notes.<project>.localhost:<port>/  (dev). No bundler, no framework build, no deploy step.
//
// It serves ONE no-build HTML page at "/" — Preact + htm + capnweb from an esm.sh importmap, the exact
// shape of the platform's own preact mini-app — and its own tiny capnweb API at "/rpc" that the page
// dials over a WebSocket. Persistence is the PROJECT's own itx.kv (this loaded code speaks for the
// project), so the notes are shared and durable. `RpcTarget`/`WorkerEntrypoint` are the runtime's own
// (inside a loaded isolate capnweb's RpcTarget IS the native one); `newWorkersRpcResponse` — which
// serves BOTH the WebSocket upgrade and a one-shot HTTP batch — comes from the injected SDK.
import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { newWorkersRpcResponse } from "./processor.js";

const KEY = "mini-app/notes";

type Kv = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
};
type Itx = { builtins: { kv: Kv } };
type Note = { id: string; text: string; at: number };

/** The mini-app's capnweb API — the methods the page calls, backed by the project's itx.kv. */
class Notes extends RpcTarget {
  constructor(private readonly itx: Itx) {
    super();
  }
  async list(): Promise<Note[]> {
    const raw = await this.itx.builtins.kv.get(KEY);
    return raw ? (JSON.parse(raw) as Note[]) : [];
  }
  async add(text: string): Promise<Note[]> {
    const notes = await this.list();
    notes.unshift({ id: crypto.randomUUID(), text: String(text), at: Date.now() });
    await this.itx.builtins.kv.put(KEY, JSON.stringify(notes));
    return notes;
  }
}

export default class MiniApp extends WorkerEntrypoint<{ ITX: { get(): Itx } }> {
  fetch(request: Request): Response | Promise<Response> {
    if (new URL(request.url).pathname === "/rpc")
      return newWorkersRpcResponse(request, new Notes(this.env.ITX.get()));
    return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
}

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Mini Notes</title>
    <script type="importmap">
      {
        "imports": {
          "preact": "https://esm.sh/preact@10.29.8",
          "preact/hooks": "https://esm.sh/preact@10.29.8/hooks",
          "htm/preact": "https://esm.sh/htm@3.1.1/preact?external=preact",
          "capnweb": "https://esm.sh/@iterate-com/capnweb@0.12.2"
        }
      }
    </script>
    <style>
      body { font: 15px/1.55 system-ui, sans-serif; max-width: 32rem; margin: 2.5rem auto; padding: 0 1rem; }
      input { font: inherit; padding: 0.4rem 0.6rem; width: 100%; box-sizing: border-box; }
      ul { list-style: none; padding: 0; } li { padding: 0.5rem 0; border-bottom: 1px solid #eee; }
      h1 { font-size: 1.2rem; }
    </style>
  </head>
  <body>
    <main id="app">Loading…</main>
    <script type="module">
      import { render } from "preact";
      import { useState, useEffect } from "preact/hooks";
      import { html } from "htm/preact";
      import { newWebSocketRpcSession } from "capnweb";

      // The app dials its OWN capnweb API at /rpc — same host, one WebSocket, no auth (it speaks for
      // the project). capnweb pipelines, so \`api\` is usable immediately.
      const rpc = new URL("/rpc", location.href);
      rpc.protocol = rpc.protocol === "https:" ? "wss:" : "ws:";
      const api = newWebSocketRpcSession(rpc.toString());

      function App() {
        const [notes, setNotes] = useState(null);
        const [text, setText] = useState("");
        useEffect(() => { api.list().then(setNotes); }, []);
        const add = async (event) => {
          event.preventDefault();
          const value = text.trim();
          if (!value) return;
          setText("");
          setNotes(await api.add(value));
        };
        return html\`
          <h1>Mini Notes</h1>
          <p>Live from the project's own <code>itx.kv</code>. <span data-testid="status">\${notes ? "live" : "connecting…"}</span></p>
          <form onSubmit=\${add}>
            <input aria-label="New note" placeholder="Write a note and press Enter…"
              value=\${text} onInput=\${(event) => setText(event.currentTarget.value)} />
          </form>
          <ul data-testid="notes">
            \${(notes || []).map((note) => html\`<li key=\${note.id}>\${note.text}</li>\`)}
          </ul>
        \`;
      }
      render(html\`<\${App} />\`, document.getElementById("app"));
    </script>
  </body>
</html>`;
