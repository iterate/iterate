// opencode v2, hosted as a userland Durable Object of this project.
//
// `OpenCodeWorkerd.create` boots the whole opencode server in-process: its
// database lives in this object's SQLite, and the services that need a real
// machine (filesystem, shell, pty) are replaced by inert stubs. Nothing here
// is platform-privileged: the class is an ordinary stateful dynamic worker,
// so it gets its own storage, a scoped `env.ITX`, and the project egress
// door as its global `fetch`. It extends the raw `DurableObject` rather than
// the SDK's `IterateDurableObject` because this worker is built in the
// platform's transform lane (no bundling — see worker.ts), where any
// `iterate/sdk` import pulls in `.mjs` dist files under names Worker Loader
// refuses; the one platform hook the host dials, `__stashSelfRef`, is a
// no-op here.
//
// That egress door is how the model call gets its credential: opencode is
// configured with `getSecret("/secrets/openai-api-key")` as the OpenAI API
// key, the ai-sdk provider puts that string in the `authorization` header,
// and the platform substitutes the real material only when the request
// leaves toward the secret's pinned origin. This worker never sees the key.
//
// Two ways in, both platform-native:
//   - RPC (capability tree): `itx.worker.opencode.prompt({ text })` from any
//     itx runtime — platform agents' codemode scripts included;
//   - fetch lane: the `opencode` app host serves a small chat page + JSON API
//     (the project worker forwards `x-iterate-app: opencode` here).

import { DurableObject } from "cloudflare:workers";
import { OpenCodeWorkerd } from "../../vendor/opencode/entry.js";

// The slice of the project's itx this file uses, declared locally: the
// platform's transform lane resolves every import specifier in the source
// (type-only ones included), and `iterate/sdk` resolves to `.mjs` dist files
// Worker Loader refuses. worker.ts, which is bundled, imports the real types.
type Project = {
  secrets: {
    get(path: string): { __describe(): Promise<{ hasMaterial: boolean }> };
    collectFromUser(input: {
      path: string;
      egress: { urls: string[] };
      description?: string;
    }): Promise<{ url: string }>;
  };
  [Symbol.dispose]?: () => void;
};
type Env = { ITX: { get(): Promise<Project> } };

const OPENAI_SECRET_PATH = "/secrets/openai-api-key";
const OPENAI_ORIGIN = "https://api.openai.com";
/** opencode sessions need a location; workerd has no filesystem behind it. */
const LOCATION = { directory: "/workspace" };

export class OpencodeAgent extends DurableObject<Env> {
  readonly #opencode: Promise<OpenCodeWorkerd.Interface>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // One host per object incarnation, booted before any event is let in —
    // the shape opencode's own Cloudflare guide prescribes.
    this.#opencode = ctx.blockConcurrencyWhile(() =>
      OpenCodeWorkerd.create({
        storage: ctx.storage,
        models: { fetch: false },
        // Not optional on Cloudflare: opencode's default logger writes a log
        // file through `node:fs`, which nodejs_compat backs with memory, and
        // its debug-level output at boot alone blows the 128MB isolate limit
        // ("Durable Object's isolate exceeded its memory limit").
        log: { level: "error" },
        config: {
          model: "openai/gpt-5.4",
          providers: {
            openai: {
              settings: { apiKey: `getSecret("${OPENAI_SECRET_PATH}")` },
            },
          },
        },
      }),
    );
  }

  /** The hosting Durable Object delivers this worker's own ref before any
   * other traffic; the SDK base class stores it for its alarm shim. This
   * object arms no alarms, so there is nothing to keep. */
  __stashSelfRef(_ref: unknown): void {}

  /** Send one user message and wait for the assistant's reply. */
  async prompt(input: { text: string; sessionID?: string }) {
    const opencode = await this.#opencode;
    const sessionID =
      input.sessionID ||
      (await opencode.sessions.create({ title: input.text.slice(0, 80), location: LOCATION })).id;
    await opencode.sessions.prompt({ sessionID, text: input.text });
    await opencode.sessions.wait({ sessionID });
    const { data: messages } = await opencode.message.list({ sessionID, order: "asc" });
    const assistant = messages.findLast((message) => message.type === "assistant");
    const reply =
      assistant?.type === "assistant"
        ? assistant.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
        : "";
    const error = assistant?.type === "assistant" ? assistant.error : undefined;
    return { sessionID, reply, error: error || null };
  }

  async sessions() {
    const opencode = await this.#opencode;
    const result = await opencode.sessions.list({ limit: 50 });
    return Array.isArray(result) ? result : result.data;
  }

  async messages(input: { sessionID: string }) {
    const opencode = await this.#opencode;
    return (await opencode.message.list({ sessionID: input.sessionID, order: "asc" })).data;
  }

  async health() {
    const opencode = await this.#opencode;
    return await opencode.server.info();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return Response.json(await this.health());
    if (url.pathname === "/api/sessions") return Response.json(await this.sessions());
    if (url.pathname === "/api/messages") {
      const sessionID = url.searchParams.get("sessionID");
      if (!sessionID) return new Response("sessionID required", { status: 400 });
      return Response.json(await this.messages({ sessionID }));
    }
    if (url.pathname === "/api/prompt" && request.method === "POST") {
      const body = (await request.json()) as { text?: unknown; sessionID?: unknown };
      if (typeof body.text !== "string" || body.text.trim() === "") {
        return new Response("text required", { status: 400 });
      }
      return Response.json(
        await this.prompt({
          text: body.text,
          ...(typeof body.sessionID === "string" && { sessionID: body.sessionID }),
        }),
      );
    }
    if (url.pathname === "/") return await this.#homePage();
    return new Response("not found", { status: 404 });
  }

  /** The chat page — or, until the API key exists, the link to enter it. */
  async #homePage(): Promise<Response> {
    const project = await this.env.ITX.get();
    try {
      const setup = await openaiKeySetupLink(project);
      const body = setup
        ? `<p>This project has no OpenAI API key yet. The key is stored in the platform's
             secret cell, pinned to <code>${OPENAI_ORIGIN}</code>; this worker never reads it.</p>
             <p><a href="${setup}">Enter the OpenAI API key</a>, then reload this page.</p>`
        : chatPage();
      return new Response(page(body), { headers: { "content-type": "text/html; charset=utf-8" } });
    } finally {
      project[Symbol.dispose]?.();
    }
  }
}

/** `null` when the key is in place; otherwise the collection-page URL. */
async function openaiKeySetupLink(project: Project): Promise<string | null> {
  const secret = project.secrets.get(OPENAI_SECRET_PATH);
  const description = await secret.__describe().catch(() => null);
  if (description?.hasMaterial) return null;
  const link = await project.secrets.collectFromUser({
    path: OPENAI_SECRET_PATH,
    egress: { urls: [OPENAI_ORIGIN] },
    description: "OpenAI API key for the opencode agent (platform.openai.com → API keys)",
  });
  return link.url;
}

function page(body: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>opencode on iterate</title>
    <style>
      body { font: 15px/1.5 system-ui, sans-serif; max-width: 48rem; margin: 2rem auto; padding: 0 1rem; }
      pre { white-space: pre-wrap; }
      .msg { padding: .5rem .75rem; margin: .5rem 0; border-radius: .5rem; background: #f4f4f5; }
      .msg.user { background: #e0f2fe; }
      .meta { color: #71717a; font-size: .8em; }
      textarea { width: 100%; min-height: 4rem; font: inherit; }
    </style>
  </head>
  <body>
    <h1>opencode on iterate</h1>
    ${body}
  </body>
</html>`;
}

/** The chat UI: plain fetches against the JSON routes above, session id in the query string. */
function chatPage(): string {
  return `
<p class="meta">opencode v2 running inside this project's Durable Object. Also callable as
<code>itx.worker.opencode.prompt({ text })</code>.</p>
<div id="log"></div>
<form id="form">
  <textarea id="text" placeholder="Ask opencode something"></textarea>
  <p><button type="submit">Send</button> <span id="status" class="meta"></span></p>
</form>
<script>
  const log = document.getElementById("log");
  const status = document.getElementById("status");
  const form = document.getElementById("form");
  const text = document.getElementById("text");
  let sessionID = new URLSearchParams(location.search).get("sessionID");

  const add = (role, body, meta) => {
    const el = document.createElement("div");
    el.className = "msg " + role;
    el.innerHTML = "<div class=meta>" + role + (meta ? " · " + meta : "") + "</div><pre></pre>";
    el.querySelector("pre").textContent = body;
    log.append(el);
  };

  const render = (messages) => {
    log.replaceChildren();
    for (const message of messages) {
      if (message.type === "user") {
        add("user", message.text);
      } else if (message.type === "assistant") {
        const body = message.content.filter((p) => p.type === "text").map((p) => p.text).join("");
        add("assistant", body || (message.error ? JSON.stringify(message.error, null, 2) : "…"),
          message.model ? message.model.providerID + "/" + message.model.id : "");
      }
    }
  };

  if (sessionID) {
    fetch("api/messages?sessionID=" + encodeURIComponent(sessionID)).then((r) => r.json()).then(render);
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = text.value.trim();
    if (!value) return;
    add("user", value);
    text.value = "";
    status.textContent = "thinking…";
    const response = await fetch("api/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: value, sessionID }),
    });
    status.textContent = response.ok ? "" : "error " + response.status;
    if (!response.ok) { add("assistant", await response.text()); return; }
    const result = await response.json();
    sessionID = result.sessionID;
    history.replaceState(null, "", "?sessionID=" + encodeURIComponent(sessionID));
    const messages = await fetch("api/messages?sessionID=" + encodeURIComponent(sessionID)).then((r) => r.json());
    render(messages);
  });
</script>`;
}
