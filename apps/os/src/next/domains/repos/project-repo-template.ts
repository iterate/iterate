const DEFAULT_PROJECT_WORKER_SOURCE = `
  import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

  export default class ProjectWorker extends WorkerEntrypoint {
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/" && req.method === "GET") {
        const counter = await this.counter();
        return this.renderCounterPage(req, await counter.current());
      }
      if (url.pathname === "/increment" && req.method === "POST") {
        const counter = await this.counter();
        return this.renderCounterPage(req, await counter.increment());
      }
      return new Response(\`project worker fetched \${new URL(req.url).pathname}\`);
    }

    counter() {
      return this.env.ITX.get().then((project) =>
        project.workers.get({
          className: "CounterDurableObject",
          durableWorkerKey: "project-ingress-counter",
          path: "/",
          source: {
            repoPath: "/",
            sourcePath: "worker.js",
            type: "repo",
          },
          type: "stateful",
        })
      );
    }

    renderCounterPage(req, count) {
      const projectId = req.headers.get("x-itx-project-id");
      const action = projectId === null ? "/increment" : \`/\${projectId}/increment\`;
      return new Response(
        \`<!doctype html>
          <html>
            <body>
              <main>
                <p>count: \${count}</p>
                <form method="post" action="\${action}">
                  <button type="submit">increment</button>
                </form>
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

  export class CounterDurableObject extends DurableObject {
    async increment() {
      const n = ((this.ctx.storage.kv.get("n")) ?? 0) + 1;
      this.ctx.storage.kv.put("n", n);
      return n;
    }

    async current() {
      return this.ctx.storage.kv.get("n") ?? 0;
    }
  }
`;

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
