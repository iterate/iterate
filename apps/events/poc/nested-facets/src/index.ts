// Nested Facets POC — verified on Cloudflare production 2026-04-21
//
// Proves that DO facets can nest: Project DO → AgentApp facet → StreamProcessor facet,
// where AgentApp and StreamProcessor both live inside a dynamically loaded worker bundle.
//
// The non-obvious part: ctx.facets.get() rejects bare class references (e.g. `class: StreamProcessor`).
// It requires a DurableObjectClass, which is an internal runtime type produced by:
//   1. workerStub.getDurableObjectClass("Name") — from outside the dynamic worker (needs LOADER)
//   2. this.ctx.exports.Name — from inside the dynamic worker (the key insight)
//
// this.ctx.exports surfaces each exported DO class as a LoopbackDurableObjectClass
// (extends DurableObjectClass). This is what makes nested facets work without needing
// to pass LOADER into the dynamic worker (which is impossible — WorkerLoader is not serializable).
//
// What's available inside a dynamic worker facet:
//   ctx.exports  → { AgentApp: LoopbackDurableObjectClass, StreamProcessor: LoopbackDurableObjectClass }
//   ctx.facets   → { get, abort, delete }
//   ctx.storage  → DurableObjectStorage with isolated SQLite per facet
//   ctx.props    → {} (unless passed via getDurableObjectClass({ props }))
//   env          → {} (empty — dynamic worker facets receive no bindings)

import { DurableObject } from "cloudflare:workers";
import { AGENT_APP_BUNDLE } from "./app-bundle.ts";

interface Env {
  PROJECT: DurableObjectNamespace<Project>;
  LOADER: WorkerLoader;
}

// Projects with custom hostnames: maps project slug → custom domain.
// When a request arrives at <project>.iterate-dev-jonas.app and the project
// has a custom domain, redirect to <app>.<custom-domain> instead.
const CUSTOM_DOMAINS: Record<string, string> = {
  brulf: "brulf.com",
};

// Resolves any incoming hostname to { app, project }.
//
// Supported formats:
//   <app>.<project>.iterate-dev-jonas.app  → app, project
//   <project>.iterate-dev-jonas.app        → project only (no app)
//   <app>.<custom-domain>                  → app, project (reverse-lookup from CUSTOM_DOMAINS)
//   <custom-domain>                        → project only (reverse-lookup)
function parseHost(host: string): { app: string | null; project: string } | null {
  // Reverse-lookup: is this a custom domain?
  for (const [slug, domain] of Object.entries(CUSTOM_DOMAINS)) {
    if (host === domain) return { app: null, project: slug };
    if (host.endsWith(`.${domain}`)) {
      const app = host.slice(0, -(domain.length + 1));
      return { app, project: slug };
    }
  }

  // Platform domain: strip .iterate-dev-jonas.app suffix
  const suffix = ".iterate-dev-jonas.app";
  if (!host.endsWith(suffix)) return null;
  const prefix = host.slice(0, -suffix.length); // "agents.test-project" or "brulf"
  const dot = prefix.indexOf(".");
  if (dot === -1) return { app: null, project: prefix };
  return { app: prefix.slice(0, dot), project: prefix.slice(dot + 1) };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const parsed = parseHost(url.hostname);
    if (!parsed) {
      return new Response("Expected host: <app>.<project>.iterate-dev-jonas.app or custom domain", {
        status: 400,
      });
    }

    // If this project has a custom domain and the request came in on the
    // platform domain, redirect to the custom domain.
    const customDomain = CUSTOM_DOMAINS[parsed.project];
    if (customDomain && url.hostname.endsWith(".iterate-dev-jonas.app")) {
      const target = parsed.app
        ? `https://${parsed.app}.${customDomain}${url.pathname}${url.search}`
        : `https://${customDomain}${url.pathname}${url.search}`;
      return Response.redirect(target, 302);
    }

    // No app in the hostname → show a landing listing available apps
    if (!parsed.app) {
      return new Response(
        `Project "${parsed.project}" — visit https://agents.${customDomain ?? `${parsed.project}.iterate-dev-jonas.app`} to use an app`,
        { status: 200, headers: { "content-type": "text/plain" } },
      );
    }

    const id = env.PROJECT.idFromName(parsed.project);
    return env.PROJECT.get(id).fetch(req);
  },
};

export class Project extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const host = new URL(req.url).hostname;
    const parsed = parseHost(host);
    if (!parsed || !parsed.app) {
      return new Response("bad host", { status: 400 });
    }
    const { app, project } = parsed as { app: string; project: string };

    console.log(
      `[Project DO] project=${project} app=${app} method=${req.method} path=${new URL(req.url).pathname}`,
    );

    const agent = this.ctx.facets.get(`app:${app}`, async () => {
      console.log(`[Project DO] loading dynamic worker for app=${app}`);
      const worker = this.env.LOADER.get(`agent:${app}`, async () => ({
        compatibilityDate: "2026-04-01",
        mainModule: "index.js",
        modules: { "index.js": AGENT_APP_BUNDLE },
        globalOutbound: null,
      }));
      return { class: worker.getDurableObjectClass("AgentApp") };
    });

    const url = new URL(req.url);

    // POST /events — full chain: Project → AgentApp → StreamProcessor
    if (req.method === "POST" && url.pathname === "/events") {
      const body = (await req.clone().json()) as { streamPath?: string };
      const streamPath = body.streamPath ?? "default";
      console.log(`[Project DO] forwarding to AgentApp facet, streamPath=${streamPath}`);

      const agentResp = await agent.fetch(
        new Request(req.url, {
          method: "POST",
          body: JSON.stringify(body),
          headers: req.headers,
        }),
      );
      const result = (await agentResp.json()) as Record<string, unknown>;
      console.log(`[Project DO] response from AgentApp:`, JSON.stringify(result));

      return renderHTML({
        project,
        app,
        streamPath,
        result: {
          layer1_Project: { project, app, DO: "real namespace" },
          layer2_AgentApp: { class: "from LOADER.getDurableObjectClass()", facetKey: `app:${app}` },
          layer3_StreamProcessor: {
            class: "from this.ctx.exports.StreamProcessor (LoopbackDurableObjectClass)",
            facetKey: `stream:${streamPath}`,
            ...((result as any).inner ?? {}),
          },
          raw: result,
        },
      });
    }

    // GET / — landing page with test form
    return renderLanding(project, app);
  }
}

function renderLanding(project: string, app: string): Response {
  const html = `<!DOCTYPE html>
<html><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width">
  <title>Nested Facets POC — ${app}.${project}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0a0a0a; color: #e0e0e0; padding: 2rem; max-width: 720px; margin: 0 auto; }
    h1 { font-size: 1.4rem; margin-bottom: .5rem; color: #fff; }
    h2 { font-size: 1rem; margin-bottom: .5rem; color: #aaa; font-weight: normal; }
    .host { color: #f59e0b; font-family: monospace; }
    .card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 1.2rem; margin: 1rem 0; }
    .layer { border-left: 3px solid; padding-left: 1rem; margin: .8rem 0; }
    .l1 { border-color: #3b82f6; }
    .l2 { border-color: #10b981; }
    .l3 { border-color: #f59e0b; }
    .tag { display: inline-block; font-size: .7rem; font-weight: 600; padding: 2px 6px; border-radius: 4px; margin-right: .4rem; }
    .tag-do { background: #1e3a5f; color: #93c5fd; }
    .tag-facet { background: #14332a; color: #6ee7b7; }
    .tag-dynamic { background: #422006; color: #fcd34d; }
    code { font-size: .85rem; background: #222; padding: 2px 6px; border-radius: 3px; }
    form { display: flex; gap: .5rem; margin-top: 1rem; }
    input { background: #222; border: 1px solid #444; color: #fff; padding: .5rem .75rem; border-radius: 6px; flex: 1; font-family: monospace; }
    button { background: #3b82f6; color: #fff; border: none; padding: .5rem 1.2rem; border-radius: 6px; cursor: pointer; font-weight: 600; }
    button:hover { background: #2563eb; }
    #result { margin-top: 1rem; white-space: pre-wrap; font-family: monospace; font-size: .8rem; }
    .arch { font-family: monospace; font-size: .75rem; line-height: 1.6; color: #888; }
    .arch b { color: #e0e0e0; font-weight: normal; }
    a { color: #60a5fa; }
  </style>
</head><body>
  <h1>Nested Facets POC</h1>
  <h2>Host: <span class="host">${app}.${project}.iterate-dev-jonas.app</span></h2>

  <div class="card">
    <div class="arch">
      <b>Worker fetch</b> → parses host → routes to <b>Project DO</b><br>
      &nbsp;&nbsp;↓<br>
      <span class="tag tag-do">DO namespace</span> <b>Project</b> "${project}"<br>
      &nbsp;&nbsp;│ facet "app:${app}" via <code>LOADER.getDurableObjectClass("AgentApp")</code><br>
      &nbsp;&nbsp;↓<br>
      &nbsp;&nbsp;<span class="tag tag-facet">facet</span><span class="tag tag-dynamic">dynamic worker</span> <b>AgentApp</b><br>
      &nbsp;&nbsp;&nbsp;&nbsp;│ facet "stream:…" via <code>this.ctx.exports.StreamProcessor</code><br>
      &nbsp;&nbsp;&nbsp;&nbsp;↓<br>
      &nbsp;&nbsp;&nbsp;&nbsp;<span class="tag tag-facet">facet</span><span class="tag tag-dynamic">dynamic worker</span> <b>StreamProcessor</b> (isolated SQLite, persistent count)
    </div>
  </div>

  <div class="card">
    <b>Send an event</b> — the stream path determines which StreamProcessor facet handles it
    <form id="f">
      <input name="streamPath" value="orders/2026-04" placeholder="streamPath">
      <button type="submit">POST /events</button>
    </form>
    <div id="result"></div>
  </div>

  <div class="card" style="font-size:.85rem; color:#888;">
    <b style="color:#ccc;">Try these to prove isolation:</b><br>
    • Same stream path → count increments (persistent storage in StreamProcessor facet)<br>
    • Different stream path → count starts at 1 (new StreamProcessor facet)<br>
    • <a href="https://billing.${project}.iterate-dev-jonas.app">billing.${project}.iterate-dev-jonas.app</a> → different AgentApp facet, separate streams<br>
    • <a href="https://${app}.acme.iterate-dev-jonas.app">${app}.acme.iterate-dev-jonas.app</a> → different Project DO, completely separate
  </div>

  <script>
    const f = document.getElementById('f');
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const sp = f.streamPath.value;
      const r = document.getElementById('result');
      r.textContent = 'sending...';
      try {
        const resp = await fetch('/events', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'accept': 'application/json' },
          body: JSON.stringify({ streamPath: sp }),
        });
        const data = await resp.json();
        r.innerHTML = formatResult(data);
      } catch (err) {
        r.textContent = 'Error: ' + err.message;
      }
    });

    function formatResult(data) {
      const l1 = data.layer1_Project || {};
      const l2 = data.layer2_AgentApp || {};
      const l3 = data.layer3_StreamProcessor || {};
      return '<div class="layer l1"><span class="tag tag-do">Layer 1</span> <b>Project DO</b>  project=<b>' + l1.project + '</b>  app=<b>' + l1.app + '</b>' +
        '<div class="layer l2"><span class="tag tag-facet">Layer 2</span><span class="tag tag-dynamic">dynamic</span> <b>AgentApp</b>  facet=<code>' + l2.facetKey + '</code>' +
        '<div class="layer l3"><span class="tag tag-facet">Layer 3</span><span class="tag tag-dynamic">dynamic</span> <b>StreamProcessor</b>  facet=<code>' + l3.facetKey + '</code>' +
        '  <b style="color:#f59e0b;font-size:1.3rem">count=' + l3.count + '</b>' +
        '</div></div></div>' +
        '<details style="margin-top:.8rem"><summary style="cursor:pointer;color:#666">Raw JSON</summary><pre>' + JSON.stringify(data, null, 2) + '</pre></details>';
    }
  </script>
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html;charset=utf-8" } });
}

function renderHTML(data: {
  project: string;
  app: string;
  streamPath: string;
  result: unknown;
}): Response {
  const accept = "application/json"; // always JSON for POST
  return Response.json(data.result, {
    headers: { "content-type": "application/json;charset=utf-8" },
  });
}
