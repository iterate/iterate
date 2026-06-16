// Reusable capability sources for the e2e suites — the sturdy (plain-data)
// capability addresses the concept tests and the catalogue examples provide.
// Mirrors apps/os/src/itx/e2e/itx-scripts.ts: these are serializable address
// values, so a Node test, the CLI, a worker, OR a browser tab can all
// provideCapability them over the same naked Cap'n Web stub.

/** A dynamic worker: one method, `add(a, b)`. The smallest sturdy capability. */
export const dynamicCalc = {
  type: "dynamic-worker",
  source: {
    type: "inline",
    mainModule: "calc.js",
    modules: {
      "calc.js": `
        import { WorkerEntrypoint } from "cloudflare:workers";
        export class CalcEntrypoint extends WorkerEntrypoint {
          add(a, b) { return a + b; }
        }
      `,
    },
  },
  entrypoint: "CalcEntrypoint",
  props: {},
};

/** A dynamic Durable Object facet sourced from the fake repo's counter.js. */
export const repoCounter = {
  type: "dynamic-durable-object",
  source: { type: "repo", repo: "shared:/repos/project", commit: "latest", path: "counter.js" },
  className: "CounterDurableObject",
};

/** A dynamic worker that returns a NESTED RpcTarget (`math`), so callers reach
 *  `kit.math.add(...)` through one naked dotted path. */
export const nestedKitWorker = {
  type: "dynamic-worker",
  source: {
    type: "inline",
    mainModule: "kit.js",
    modules: {
      "kit.js": `
        import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
        class MathTarget extends RpcTarget {
          add(a, b) { return a + b; }
        }
        export class KitEntrypoint extends WorkerEntrypoint {
          echo(value) { return { echoed: value }; }
          get math() { return new MathTarget(); }
        }
      `,
    },
  },
  entrypoint: "KitEntrypoint",
  props: {},
};

/** A Slack-shaped dynamic worker: the SAME caller surface as a live SDK
 *  (`slack.chat.postMessage`) but stored as an address, not an in-memory stub. */
export const addressedSlackWorker = {
  type: "dynamic-worker",
  source: {
    type: "inline",
    mainModule: "slack.js",
    modules: {
      "slack.js": `
        import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
        class ChatTarget extends RpcTarget {
          postMessage(body) {
            return {
              args: [body],
              method: "chat.postMessage",
              provider: "dynamic-worker-address",
            };
          }
        }
        export class SlackEntrypoint extends WorkerEntrypoint {
          get chat() { return new ChatTarget(); }
        }
      `,
    },
  },
  entrypoint: "SlackEntrypoint",
  props: {},
};

/** A dynamic worker exposing a count + a nested SKU price lookup. */
export const inventoryWorker = {
  type: "dynamic-worker",
  source: {
    type: "inline",
    mainModule: "inventory.js",
    modules: {
      "inventory.js": `
        import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
        class Skus extends RpcTarget {
          priceOf({ sku }) { return sku === "ABC" ? 42 : 0; }
        }
        export class InventoryEntrypoint extends WorkerEntrypoint {
          count() { return 7; }
          get skus() { return new Skus(); }
        }
      `,
    },
  },
  entrypoint: "InventoryEntrypoint",
  props: {},
};

/** A dynamic worker that discovers `inventory` through its OWN scoped
 *  env.ITX.get() — worker-to-worker composition without a direct binding. */
export const reportWorker = {
  type: "dynamic-worker",
  source: {
    type: "inline",
    mainModule: "report.js",
    modules: {
      "report.js": `
        import { WorkerEntrypoint } from "cloudflare:workers";
        export class ReportEntrypoint extends WorkerEntrypoint {
          async build({ sku }) {
            const itx = await this.env.ITX.get();
            const count = await itx.inventory.count();
            const price = await itx.inventory.skus.priceOf({ sku });
            return { count, price, total: count * price };
          }
        }
      `,
    },
  },
  entrypoint: "ReportEntrypoint",
  props: {},
};

/** A dynamic Durable Object whose source can advance v1 → v2 while the mounted
 *  storage survives — the durable identity is the mount path, not the hash. */
export const upgradeCounter = (version: "v1" | "v2") => ({
  type: "dynamic-durable-object",
  source: {
    type: "inline",
    mainModule: "upgrade-counter.js",
    modules: {
      "upgrade-counter.js": `
        import { DurableObject } from "cloudflare:workers";
        export class UpgradeCounterDurableObject extends DurableObject {
          version() { return "${version}"; }
          async increment() {
            const n = ((await this.ctx.storage.get("n")) ?? 0) + 1;
            await this.ctx.storage.put("n", n);
            return n;
          }
          async current() {
            return (await this.ctx.storage.get("n")) ?? 0;
          }
        }
      `,
    },
  },
  className: "UpgradeCounterDurableObject",
});
