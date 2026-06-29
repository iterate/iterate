const DEFAULT_PROJECT_WORKER_SOURCE = `
  import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

  export default class ProjectWorker extends WorkerEntrypoint {
    fetch(req) {
      return new Response(\`project worker fetched \${new URL(req.url).pathname}\`);
    }

    processEvent(input) {
      console.log("project worker processed", input.event.type);
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
