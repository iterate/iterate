// __workers-tests__/sources.ts — named loaded code the Workers rows hand over inline like a person's
// own: a facet spec (`{ source, className }`) for `itx.facets.get(name, spec)` and
// `itx.processors.enable`, or a worker source for `itx.workers.get`. It holds COUNTER_SOURCE, which
// several files build on, and the facet rows' (facets.test.ts) sources; other rows keep their own
// source inline. A processor that counts is built on `counter`, the counter processor every counting
// fixture shares.
import type { FacetSpec, WorkerSource } from "iterate/api";

/** A module whose `CounterProcessor` counts every durable event (`{ n }`), with `host` — the
 *  Durable Object class that runs it — below. */
const counter = (host: string) => /* js */ `
import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "iterate/sdk";
const contract = defineProcessorContract({
  slug: "counter",
  version: "1.0.0",
  description: "counts durable events",
  stateSchema: z.object({ n: z.number().default(0) }),
  consumes: ["*"],
  emits: [],
});
class CounterProcessor extends StreamProcessor {
  contract = contract;
  reduce({ state }) { return { n: state.n + 1 }; }
}
${host}`;

/** The counter processor and its host `CounterDurableObject`, which is what the load chain names. */
export const COUNTER_SOURCE = counter(/* js */ `
export class CounterDurableObject extends StreamProcessorDurableObject {
  processor = new CounterProcessor();
}
`);

/** The counter, recording every push, revive and catch-up in its own SQLite before the engine runs
 *  it, so a fresh instance after an abort sees the history; `probe()` reads those and the checkpoint
 *  without touching the engine. While `hangs`, it hangs forever on a batch carrying a `pin/hang`
 *  event, on its first revive and on the catch-up `armCatchUpHang()` armed. The two are one class
 *  from two sources: two loaded identities. */
export const hangingCounter = (hangs: boolean): FacetSpec => ({
  source: {
    "worker.js": counter(/* js */ `
const HANG = ${hangs};
export class HangingCounterDurableObject extends StreamProcessorDurableObject {
  static publicMethods = [...super.publicMethods, "probe", "armCatchUpHang"];
  processor = new CounterProcessor();
  #tables() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS seen (seq INTEGER PRIMARY KEY AUTOINCREMENT, through INTEGER, hung INTEGER)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS revives (seq INTEGER PRIMARY KEY AUTOINCREMENT, hung INTEGER)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS catchups (seq INTEGER PRIMARY KEY AUTOINCREMENT, hung INTEGER)",
    );
  }
  /** The NEXT catch-up hangs (once: the flag is spent by the catch-up that reads it). */
  armCatchUpHang() {
    this.ctx.storage.kv.put("hang-next-catch-up", true);
  }
  async catchUpFromLog() {
    this.#tables();
    const hang = HANG && Boolean(this.ctx.storage.kv.get("hang-next-catch-up"));
    this.ctx.storage.kv.delete("hang-next-catch-up");
    this.ctx.storage.sql.exec("INSERT INTO catchups (hung) VALUES (?)", hang ? 1 : 0);
    if (hang) await new Promise(() => {});
    return super.catchUpFromLog();
  }
  async processEventBatch(events, range) {
    this.#tables();
    const hang = HANG && events.some((e) => e.type === "pin/hang");
    this.ctx.storage.sql.exec("INSERT INTO seen (through, hung) VALUES (?, ?)", range.through, hang ? 1 : 0);
    if (hang) await new Promise(() => {});
    return super.processEventBatch(events, range);
  }
  async revive() {
    this.#tables();
    const hang = HANG && this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM revives").one().n === 0;
    this.ctx.storage.sql.exec("INSERT INTO revives (hung) VALUES (?)", hang ? 1 : 0);
    if (hang) await new Promise(() => {});
    return super.revive();
  }
  probe() {
    this.#tables();
    let checkpoints = [];
    try {
      checkpoints = this.ctx.storage.sql
        .exec("SELECT reduced_through_offset, state FROM reduce_checkpoints")
        .toArray();
    } catch {}
    return {
      seen: this.ctx.storage.sql.exec("SELECT * FROM seen").toArray(),
      revives: this.ctx.storage.sql.exec("SELECT * FROM revives").toArray(),
      catchups: this.ctx.storage.sql.exec("SELECT * FROM catchups").toArray(),
      checkpoints,
    };
  }
}
`),
  },
  className: "HangingCounterDurableObject",
});

/** The text of V8's clone-version rejection, the platform's facet-start defect. */
export const CLONE_VERSION_TEXT =
  "Unable to deserialize cloned data due to invalid or unsupported version.";

/** The counter, whose FIRST push ever rejects with `message`; every try is recorded in its own
 *  SQLite, which survives the abort and the new isolate. */
export const flakyCounter = (message: string): FacetSpec => ({
  source: {
    "worker.js": counter(/* js */ `
export class FlakyDurableObject extends StreamProcessorDurableObject {
  static publicMethods = [...super.publicMethods, "tries"];
  processor = new CounterProcessor();
  #tries() {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS tries (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER)");
  }
  async processEventBatch(events, range) {
    this.#tries();
    const before = Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM tries").one().n);
    this.ctx.storage.sql.exec("INSERT INTO tries (at) VALUES (?)", Date.now());
    if (before === 0) throw new Error(${JSON.stringify(message)});
    return super.processEventBatch(events, range);
  }
  tries() {
    this.#tries();
    return this.ctx.storage.sql.exec("SELECT * FROM tries").toArray();
  }
}
`),
  },
  className: "FlakyDurableObject",
});

/** A loaded worker's modules, produced by a facet: none on the first `modules()` (the failed load),
 *  the site after 300 ms on every later one (a cold repo fetch); `runs()` counts them. */
export const PRODUCER: FacetSpec = {
  source: {
    "worker.js": counter(/* js */ `
export class ProducerDurableObject extends StreamProcessorDurableObject {
  static publicMethods = [...super.publicMethods, "modules", "runs"];
  processor = new CounterProcessor();
  runs() {
    return this.ctx.storage.kv.get("runs") ?? 0;
  }
  async modules() {
    const runs = this.runs() + 1;
    this.ctx.storage.kv.put("runs", runs);
    if (runs === 1) return null; // no modules: the load fails inside the loader
    await new Promise((resolve) => setTimeout(resolve, 300));
    return {
      "worker.js": "import { WorkerEntrypoint } from 'cloudflare:workers'; export default class Site extends WorkerEntrypoint { hello() { return 'hi'; } }",
    };
  }
}
`),
  },
  className: "ProducerDurableObject",
};

/** A person's own processor, the counter with a method of its own (`hello`). */
export const HELLO_PROCESSOR: FacetSpec = {
  source: {
    "worker.js": counter(/* js */ `
export class TallyDurableObject extends StreamProcessorDurableObject {
  static publicMethods = [...super.publicMethods, "hello"];
  processor = new CounterProcessor();
  hello() { return "hello from a loaded processor"; }
}
`),
  },
  className: "TallyDurableObject",
};

/** A tally of `test/counted` events whose host counts its round trips to its context. The
 *  projection is constant, so no live-state delta rides the scope and it runs no background work:
 *  every round trip it makes is a catch-up's read of the log. */
export const COUNTING_TALLY: FacetSpec = {
  source: {
    "worker.js": /* js */ `
import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "iterate/sdk";
const contract = defineProcessorContract({
  slug: "tally",
  version: "1.0.0",
  description: "counts test/counted events",
  stateSchema: z.object({ n: z.number().default(0) }),
  consumes: ["test/counted"],
  emits: [],
});
class TallyProcessor extends StreamProcessor {
  contract = contract;
  reduce({ state }) { return { n: state.n + 1 }; }
  projectLiveState() { return null; }
}
export class CountingTallyDurableObject extends StreamProcessorDurableObject {
  static publicMethods = [...super.publicMethods, "logReads"];
  processor = new TallyProcessor();
  #roundTrips = 0;
  withItx(call) {
    this.#roundTrips++;
    return super.withItx(call);
  }
  logReads() { return this.#roundTrips; }
}
`,
  },
  className: "CountingTallyDurableObject",
};

/** A person's own processor that counts the `events.iterate.com/test/ticked` events on its log. */
export const TICK_TALLY: FacetSpec = {
  source: {
    "worker.js": /* js */ `
import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "iterate/sdk";
const contract = defineProcessorContract({
  slug: "tally",
  version: "1.0.0",
  description: "counts the ticks on its context's log",
  stateSchema: z.object({ ticks: z.number().default(0) }),
  consumes: ["*"],
  emits: [],
});
class TallyProcessor extends StreamProcessor {
  contract = contract;
  reduce({ state, event }) {
    return event.type === "events.iterate.com/test/ticked" ? { ticks: state.ticks + 1 } : state;
  }
}
export class TallyDurableObject extends StreamProcessorDurableObject {
  processor = new TallyProcessor();
}
`,
  },
  className: "TallyDurableObject",
};

/** A facet with in-memory state only: `hello()` counts its calls and names the instance, and so
 *  does its page. A fresh instance shows as `calls` back to 1 and a new `instance`. */
export const HELLO: FacetSpec = {
  source: {
    "worker.js": /* js */ `
import { FacetDurableObject } from "iterate/sdk";
export class Hello extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "hello"];
  calls = 0;
  instance = crypto.randomUUID();
  hello() { this.calls++; return { calls: this.calls, instance: this.instance }; }
  fetch() { return new Response(this.instance); }
}
`,
  },
  className: "Hello",
};

/** A facet that is also a push target: it counts what the delivery loop hands it — the two verbs
 *  the loop calls on a facet row, `catchUpFromLog` once at enable and `processEventBatch` per
 *  batch — in memory, read back through `stats()`. */
export const PUSH_TALLY: FacetSpec = {
  source: {
    "worker.js": /* js */ `
import { FacetDurableObject } from "iterate/sdk";
export class Tally extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "hello", "stats"];
  batches = 0;
  events = 0;
  catchUpFromLog() {}
  processEventBatch(events) { this.batches++; this.events += events.length; }
  hello() { return "hello from loaded code"; }
  stats() { return { batches: this.batches, events: this.events }; }
}
`,
  },
  className: "Tally",
};

/** A facet whose constructor throws until the time `failStartsFor(ms)` set in its own storage. */
export const FRAGILE: FacetSpec = {
  source: {
    "worker.js": /* js */ `
import { FacetDurableObject } from "iterate/sdk";
export class FragileDurableObject extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "failStartsFor", "hello"];
  constructor(ctx, env) {
    super(ctx, env);
    if (Date.now() < (ctx.storage.kv.get("fail-until") ?? 0)) throw new Error("not now");
  }
  failStartsFor(ms) { this.ctx.storage.kv.put("fail-until", Date.now() + ms); }
  hello() { return "hello"; }
}
`,
  },
  className: "FragileDurableObject",
};

/** A stateful app: `fetch()` serves plain HTTP AND would upgrade a WebSocket if asked, so a refused
 *  upgrade is the platform's refusal, not the class's. `hits()` counts what reached it. */
export const APP_FACET: FacetSpec = {
  source: {
    "worker.js": /* js */ `
import { FacetDurableObject } from "iterate/sdk";
export class AppFacetDurableObject extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "hits"];
  #hits = 0;
  fetch(request) {
    this.#hits++;
    if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      pair[1].accept();
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return Response.json({ served: "plain-http", hits: this.#hits, path: new URL(request.url).pathname });
  }
  hits() { return this.#hits; }
}
`,
  },
  className: "AppFacetDurableObject",
};

/** A loaded class that extends neither SDK facet shell, so it lists no public method. */
export const PLAIN_DURABLE_OBJECT: FacetSpec = {
  source: {
    "worker.js": /* js */ `
import { DurableObject } from "cloudflare:workers";
export class Plain extends DurableObject {
  hello() { return "hello from a plain Durable Object"; }
  fetch() { return new Response("plain"); }
}
`,
  },
  className: "Plain",
};

/** A plain Durable Object module (`probe.js`) whose `identity()` reports what its `ctx` carries. */
export const IDENTITY_PROBE = /* js */ `
import { DurableObject } from "cloudflare:workers";
export class ProbeDurableObject extends DurableObject {
  identity() {
    return {
      props: this.ctx.props ?? null,
      idName: this.ctx.id?.name ?? null,
      exportsKind: typeof this.ctx.exports,
    };
  }
}
`;

/** A stateless worker with one method. */
export const HELLO_WORKER: WorkerSource = {
  "worker.js": /* js */ `
import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint { hello() { return "hello from loaded code"; } }
`,
};

/** A worker whose first isolate to serve a request is a bad cache entry: it marks itself in its
 *  context's kv and throws the clone-version text on every request it serves; any other isolate
 *  answers. */
export const CLONE_VERSION_WORKER: WorkerSource = {
  "worker.js": /* js */ `
import { WorkerEntrypoint } from "cloudflare:workers";
import { withItx } from "iterate/sdk";
let isolate;
export default class Site extends WorkerEntrypoint {
  fetch(request) {
    isolate ??= crypto.randomUUID();
    return withItx(this.env.ITX, async (itx) => {
      let bad = await itx.kv.get("bad-isolate");
      if (!bad) {
        await itx.kv.put("bad-isolate", isolate);
        bad = isolate;
      }
      if (bad === isolate) throw new Error(${JSON.stringify(CLONE_VERSION_TEXT)});
      return new Response(request.method + " from a healthy isolate");
    });
  }
}
`,
};
