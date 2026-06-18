import { hashString, type ResolvedWorkerSource } from "../dynamic-workers/dynamic-worker-loader.ts";

export function fakeRepoWorkerSource({ path }: { path: string }): ResolvedWorkerSource {
  if (path !== "counter.js") {
    throw new Error(`fake repo only contains counter.js, not ${path}`);
  }
  const source = `
    import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

    export class CounterEntrypoint extends WorkerEntrypoint {
      add(a, b) { return a + b; }
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
  return {
    cacheKey: hashString(source),
    mainModule: "counter.js",
    modules: { "counter.js": source },
  };
}
