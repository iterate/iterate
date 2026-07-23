import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { env as workerEnv } from "cloudflare:workers";
import { newWorkersWebSocketRpcResponse } from "capnweb";
import { getServerByName } from "partyserver";
import type { AppEnv } from "./env.ts";
import { TasksApiRoot } from "./rpc-api.ts";
import { isCheckoutId, normalizeRepoPath } from "./lib/checkout-shared.ts";

export { TasksCheckoutDurableObject } from "./checkout-do.ts";
export { TasksCheckoutIndexDurableObject } from "./checkout-index-do.ts";

// wrangler.jsonc declares exactly these; the app is small enough that a
// hand-written env type beats generated worker configuration types.
const env = workerEnv as unknown as AppEnv;

const PROJECT_ID_HEADER = "x-itx-project-id";

/**
 * Landing page for direct hits on the vessel host (no proxy headers): a
 * slug prompt that jumps to `tasks--<slug>.iterate.app`, with the install
 * explanation folded behind a disclosure.
 */
function landingPage(): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tasks for iterate</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #fafafa;
      color: #171717;
      font-family: system-ui, sans-serif;
      font-size: 14px;
      line-height: 1.55;
    }
    main { max-width: 34rem; margin: 14vh auto 3rem; padding: 0 1.25rem; }
    h1 { font-size: 1.3rem; margin: 0 0 0.4rem; letter-spacing: -0.01em; }
    p { color: #555; margin: 0 0 1rem; }
    form { display: flex; gap: 0.5rem; margin: 1.25rem 0 0.75rem; }
    input {
      flex: 1;
      font: inherit;
      padding: 0.45rem 0.7rem;
      border: 1px solid #d4d4d4;
      border-radius: 8px;
      background: #fff;
    }
    input:focus { outline: 2px solid #a3a3a3; outline-offset: 0; }
    button {
      font: inherit;
      font-weight: 500;
      padding: 0.45rem 0.9rem;
      border: 1px solid #171717;
      border-radius: 8px;
      background: #171717;
      color: #fff;
      cursor: pointer;
    }
    button:hover { background: #333; }
    details { margin-top: 1.5rem; border: 1px solid #e5e5e5; border-radius: 10px; background: #fff; }
    summary {
      cursor: pointer;
      padding: 0.6rem 0.9rem;
      font-weight: 500;
      color: #333;
      list-style-position: inside;
    }
    .install { padding: 0 0.9rem 0.9rem; }
    code, pre { font-family: ui-monospace, monospace; }
    code { background: #f0f0f0; border-radius: 4px; padding: 0.05rem 0.3rem; }
    pre {
      overflow-x: auto;
      background: #171717;
      color: #e6e8eb;
      border-radius: 8px;
      padding: 0.9rem;
      font-size: 0.75rem;
      line-height: 1.45;
    }
    pre code { background: transparent; padding: 0; color: inherit; }
    .hint { font-size: 0.8rem; color: #777; }
  </style>
</head>
<body>
  <main>
    <h1>Tasks</h1>
    <p>
      Linear-style task management for your iterate project, backed by its git
      repositories. Boards are live collaborative views of the
      <code>tasks/</code> markdown in your repos; commits go straight back to
      git. This app stores no data at all.
    </p>
    <form id="go">
      <input id="slug" placeholder="your-project-slug" autocomplete="off" autofocus
        aria-label="Your iterate project slug" />
      <button type="submit">Open my tasks</button>
    </form>
    <p class="hint">Takes you to <code>tasks--&lt;slug&gt;.iterate.app</code> and signs you in with your iterate account.</p>
    <details>
      <summary>How do I add this to my project?</summary>
      <div class="install">
        <p>
          New iterate projects have the tasks app out of the box. If yours
          predates it, add a <code>tasks</code> branch to the app router in
          your project&rsquo;s <code>/repos/config</code> <code>worker.ts</code>
          &mdash; a project-member gate plus a transparent reverse proxy to
          this host. The platform stamps the project id and forwards each
          visitor&rsquo;s short-lived session cookie, which the vessel proves
          against <code>os.iterate.com</code> per connection; no secrets or
          state live here.
        </p>
        <pre><code>if (app === "tasks") {
  using itx = await this.env.ITX.get();
  const denied = await itx.auth.get({ policy: "project-member" }).fetch(req);
  if (denied) return denied;
  const tasksUrl = new URL(req.url);
  tasksUrl.protocol = "https:";
  const origin = await itx.kv.get("tasks-app-origin");
  tasksUrl.host =
    typeof origin === "string" &amp;&amp; origin !== "" ? origin : "tasks.iterate.workers.dev";
  return fetch(
    new Request(tasksUrl, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: "manual",
    }),
  );
}</code></pre>
        <p class="hint">
          The <code>tasks-app-origin</code> kv knob points the proxy at a dev
          tunnel while hacking on the tasks app itself; leave it unset for the
          deployed vessel.
        </p>
      </div>
    </details>
  </main>
  <script>
    document.getElementById("go").addEventListener("submit", (event) => {
      event.preventDefault();
      const slug = document.getElementById("slug").value.trim().toLowerCase()
        .replace(/[^a-z0-9-]/g, "");
      if (slug) window.location.href = "https://tasks--" + slug + ".iterate.app/";
    });
  </script>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export default createServerEntry({
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    // The vessel's ONE api root: a Cap'n Web WebSocket session. It sits
    // before the project-header gate on purpose: agents and services dial
    // the vessel host directly and authenticate with an explicit credential
    // (whose own project claim scopes the session), while proxied browser
    // traffic authenticates via the cookie riding its upgrade.
    if (url.pathname === "/api") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("capnweb WebSocket only — upgrade required", { status: 426 });
      }
      return newWorkersWebSocketRpcResponse(request, new TasksApiRoot(env, request));
    }

    const projectId = request.headers.get(PROJECT_ID_HEADER);

    // No project header → this is a direct hit on the vessel host, not
    // proxied project traffic. Serve only the static landing page.
    if (!projectId) {
      return landingPage();
    }

    // The Yjs lane: y-protocols sync + awareness for one checkout, kept off
    // /api because it's binary y-websocket wire, not capnweb. One DO per
    // (project, repo, checkout id) — the repo rides as ?repoPath= and is
    // bound into the DO name.
    const yjs = /^\/yjs\/([^/]+)$/.exec(url.pathname);
    if (yjs) {
      const checkoutId = decodeURIComponent(yjs[1]!);
      const repoPath = normalizeRepoPath(url.searchParams.get("repoPath"));
      if (!isCheckoutId(checkoutId) || repoPath === null) {
        return new Response("bad checkout id or repo path", { status: 400 });
      }
      const stub = await getServerByName(
        env.CHECKOUT as unknown as Parameters<typeof getServerByName>[0],
        `${projectId}:${repoPath}:${checkoutId}`,
      );
      return stub.fetch(request);
    }

    // TanStack SSR pages must never be cached: a stale HTML shell references
    // retired asset hashes and resurrects old UI until a hard refresh. The
    // hashed /assets/* files keep their long-lived caching.
    const response = await handler.fetch(request);
    if ((response.headers.get("content-type") ?? "").includes("text/html")) {
      const fresh = new Response(response.body, response);
      fresh.headers.set("cache-control", "no-store");
      return fresh;
    }
    return response;
  },
});
