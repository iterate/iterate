export const DEFAULT_PROJECT_WORKER_SOURCE = `
  import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

  export default class ProjectWorker extends WorkerEntrypoint {
    add(a, b) {
      return a + b;
    }

    greet(name = "world") {
      return \`hello, \${name}\`;
    }
  }

  export class CounterDurableObject extends DurableObject {
    async increment() {
      const n = ((await this.ctx.storage.get("n")) ?? 0) + 1;
      await this.ctx.storage.put("n", n);
      return n;
    }

    async current() {
      return (await this.ctx.storage.get("n")) ?? 0;
    }
  }
`;

export const PROJECT_REPO_INITIAL_FILES = [
  {
    content: DEFAULT_PROJECT_WORKER_SOURCE,
    path: "worker.js",
  },
  {
    content:
      "# Minimal ITX v2 project repo\n\nThis repo is seeded by RepoDurableObject.create().\n",
    path: "README.md",
  },
];
