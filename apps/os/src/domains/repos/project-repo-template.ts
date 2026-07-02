const DEFAULT_PROJECT_WORKER_SOURCE = `
  import { WorkerEntrypoint } from "cloudflare:workers";

  // The root project worker is a small ROUTER over the project's apps. Each
  // app is its own repo-backed dynamic worker (a self-contained JS module —
  // repo-backed workers are single-file for now); ingress selects one via the
  // trusted x-iterate-app header (hosts like hello--<slug>.<base> or
  // <app>.<custom-hostname>). Requests with no app selected get the static
  // homepage string below.
  const APPS = {
    hello: {
      type: "stateless",
      path: "/",
      source: { type: "repo", repoPath: "/", sourcePath: "apps/hello/worker.js" },
    },
    counter: {
      type: "stateful",
      path: "/",
      className: "CounterApp",
      durableWorkerKey: "app-counter",
      source: { type: "repo", repoPath: "/", sourcePath: "apps/counter/worker.js" },
    },
  };

  export default class ProjectWorker extends WorkerEntrypoint {
    async fetch(req) {
      const appSlug = req.headers.get("x-iterate-app");
      if (appSlug) {
        const ref = APPS[appSlug];
        if (!ref) return new Response(\`unknown app: \${appSlug}\`, { status: 404 });
        const project = await this.env.ITX.get();
        // Workers RPC: await the capability before calling through it.
        const app = await project.workers.get(ref);
        return await app.fetch(req);
      }

      // The seeded homepage is a static page linking to the apps. Apps live
      // on their own hosts: the current host prefixed with "<app>--" (e.g.
      // counter--<slug>.<base>), so the links derive from the request URL.
      const url = new URL(req.url);
      const appLinks = Object.entries(APPS)
        .map(([slug, ref]) => {
          const href = \`\${url.protocol}//\${slug}--\${url.host}/\`;
          return \`<li><a href="\${href}">\${slug}</a> (\${ref.type})</li>\`;
        })
        .join("\\n");
      return new Response(
        \`<!doctype html>
          <html>
            <body>
              <main>
                <p>Hello from your Iterate project worker.</p>
                <ul>\${appLinks}</ul>
                <p>Edit worker.js in the project repo to change this.</p>
              </main>
            </body>
          </html>\`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }

    processEvent(input) {
      console.log("project worker processed", input.event.type);
    }

    async testFetch(input) {
      const response = await fetch(input.url, {
        headers: { "x-itx-egress-proof": input.headerValue },
      });
      return await response.json();
    }
  }
`;

const HELLO_APP_WORKER_SOURCE = `
  import { WorkerEntrypoint } from "cloudflare:workers";

  // A stateless app: a plain WorkerEntrypoint the root project worker routes
  // to when ingress selects the "hello" app. It still gets the full project
  // itx through env.ITX.
  export default class HelloApp extends WorkerEntrypoint {
    async fetch(req) {
      const project = await this.env.ITX.get();
      const description = await project.describe();
      return Response.json({
        app: "hello",
        path: new URL(req.url).pathname,
        projectId: description.projectId,
      });
    }
  }
`;

const COUNTER_APP_WORKER_SOURCE = `
  import { DurableObject } from "cloudflare:workers";

  // A stateful app: a Durable Object class hosted as a repo-backed stateful
  // dynamic worker. State survives across requests under its durableWorkerKey.
  export class CounterApp extends DurableObject {
    async fetch(req) {
      // The path lane advertises its stripped URL prefix; host lanes have none.
      const prefix = req.headers.get("x-iterate-url-prefix") ?? "";
      const url = new URL(req.url);

      if (req.method === "POST" && url.pathname === "/increment") {
        await this.increment();
        // Redirect back so the browser URL never sticks at /increment.
        return new Response(null, { status: 303, headers: { location: \`\${prefix}/\` } });
      }

      const count = await this.current();
      return new Response(
        \`<!doctype html>
          <html>
            <body>
              <main>
                <p>count: \${count}</p>
                <form method="post" action="\${prefix}/increment">
                  <button type="submit">increment</button>
                </form>
              </main>
            </body>
          </html>\`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }

    async increment() {
      const n = ((this.ctx.storage.kv.get("n")) ?? 0) + 1;
      this.ctx.storage.kv.put("n", n);
      return n;
    }

    async current() {
      return this.ctx.storage.kv.get("n") ?? 0;
    }
  }`;

export const PROJECT_REPO_AGENTS_MD = `# Project Agent Notes

This private repo is the durable brain for the project's agents.

Agents should keep useful, stable project knowledge here: user preferences,
working agreements, product decisions, research summaries, unresolved questions,
and implementation notes that future agents should inherit. Prefer concise
markdown files that are easy to scan and update. Commit changes with
\`itx.repo.commitFiles({ message, changes: [{ path, content }] })\`.

The project worker entrypoint is \`worker.js\` (plain JavaScript modules). Its
default export handles HTTP for the project's hosts, receives every committed
project event through \`processEvent({ event })\`, and reaches the project's
capabilities through \`await this.env.ITX.get()\`.
`;

export const PROJECT_REPO_ONBOARDING_MD = `# Onboarding Agent

The onboarding agent helps a new project owner turn a blank Iterate project into
a useful working space.

On the first turn:

1. Welcome the user briefly (by name only if they gave one).
2. Explain what this project comes with: a private repo (seeded with this file,
   AGENTS.md, and the project worker at worker.js), durable event streams, and
   agents like you that can act on the project.
3. Ask one focused question about what they want this project to help with.

During onboarding:

- Keep replies short and concrete. Ask one question at a time.
- When the user gives stable project facts, write them into the project repo as
  concise markdown: prefer updating AGENTS.md or adding small files under
  docs/, via itx.repo.commitFiles({ message, changes: [{ path, content }] }).
- You can demonstrate the platform when it helps: append events with
  itx.streams.get(path).append({ type, payload }), inspect history with
  getEvents(), connect external tools with itx.mcp.connect({ url }) or
  itx.openapi.connect({ specUrl }), and change the project worker by
  committing to worker.js.
- After you have captured the project purpose, working agreements, and first
  tasks, append events.iterate.com/project/onboarding-completed on the root
  project stream (itx.streams.get("/")) with payload
  { agentPath: "/agents/onboarding" }.

Do not mark onboarding complete just because the first message was answered.
`;

export const PROJECT_REPO_INITIAL_FILES = [
  {
    content: DEFAULT_PROJECT_WORKER_SOURCE,
    path: "worker.js",
  },
  {
    content: HELLO_APP_WORKER_SOURCE,
    path: "apps/hello/worker.js",
  },
  {
    content: COUNTER_APP_WORKER_SOURCE,
    path: "apps/counter/worker.js",
  },
  {
    content:
      "# Iterate project repo\n\nThis repo is seeded at project creation by the repo stream processor.\n",
    path: "README.md",
  },
  {
    content: PROJECT_REPO_AGENTS_MD,
    path: "AGENTS.md",
  },
  {
    content: PROJECT_REPO_ONBOARDING_MD,
    path: "ONBOARDING.md",
  },
];
