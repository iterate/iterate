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

export const PROJECT_REPO_INITIAL_FILES = [
  {
    content: DEFAULT_PROJECT_WORKER_SOURCE,
    path: "worker.js",
  },
  {
    content: "# Minimal ITX v4 project repo\n\nThis repo is seeded by the repo stream processor.\n",
    path: "README.md",
  },
];
