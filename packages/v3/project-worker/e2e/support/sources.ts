// e2e/support/sources.ts — the demo module sources the E2E tests seed into plain kv (source is kv
// like everything else; a future real repo mounts at itx.files as an ordinary capability). Each test
// seeds only what it uses:
//   await seedSources(itx, ["site", "counter"]);
//   ...source: "itx.kv.get('src/site.js')"...

const SOURCES: Record<string, string> = {
  "src/counter.js": `import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject {
  async increment(by) { const n = ((await this.ctx.storage.get("n")) ?? 0) + by; await this.ctx.storage.put("n", n); return n; }
  async value() { return (await this.ctx.storage.get("n")) ?? 0; }
  async whoAmI() { return await (await this.env.ITX.get()).whoami(); }
  get counters() {
    const self = this;
    return { async add(by) { return self.increment(by); } };
  }
}`,
  "src/chatroom.js": `import { DurableObject } from "cloudflare:workers";
import { LiveState } from "./processor.js";
export class Chatroom extends DurableObject {
  #chat = new LiveState(this.env.ITX, "chat", { messages: [] });
  post(from, text) {
    this.#chat.set({ messages: [...this.#chat.get().messages, { from, text }] });
    return { ok: true };
  }
  state() { return this.#chat.snapshot(); }
}`,
  "src/probe.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Probe extends WorkerEntrypoint {
  async run(v, cb) {
    return {
      ctor: v?.constructor?.name ?? typeof v,
      cbResult: typeof cb === "function" ? await cb(7) : null,
    };
  }
}`,
  "src/keeper.js": `import { DurableObject } from "cloudflare:workers";
export class Keeper extends DurableObject {
  async stash() {
    await this.ctx.storage.put("itx-cap", this.env.ITX);
    return { stashed: true };
  }
  async useStashed() {
    const cap = await this.ctx.storage.get("itx-cap");
    if (!cap) throw new Error("keeper: nothing stashed");
    return await (await cap.get()).whoami();
  }
}`,
  // The stateless "project worker" shape: a WorkerEntrypoint whose processEventBatch(events, range) the
  // stream calls at-least-once from a cursor it keeps (resolving IS the ack; throwing ⇒ retry;
  // `retryable: false` ⇒ halt now).
  "src/digest.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Digest extends WorkerEntrypoint {
  async processEventBatch(events, range) {
    const poison = events.find((e) => e.payload && e.payload.poison);
    if (poison)
      throw Object.assign(new Error("digest: refusing poison at offset " + poison.offset), {
        retryable: false, // the stamped-flag doctrine: never-retryable halts NOW, not in 30 min
      });
    const itx = await this.env.ITX.get();
    const n = Number((await itx.kv.get("digested")) ?? 0) + events.length;
    await itx.kv.put("digested", String(n));
    return n;
  }
}`,
  "src/chunky.js": `import { StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";
const contract = defineProcessorContract({
  slug: "chunky",
  version: "1.0.0",
  description: "Counts named ephemeral chunks beside durable marks.",
  stateSchema: z.object({ chunks: z.number().default(0), marks: z.number().default(0) }),
  events: {},
  consumes: ["chunk", "mark"],
  emits: [],
});
export class Chunky extends StreamProcessorDurableObject {
  contract = contract;
  reduce({ event, state }) {
    if (event.type === "chunk") return { ...state, chunks: state.chunks + 1 };
    if (event.type === "mark") return { ...state, marks: state.marks + 1 };
  }
  projectLiveState(state) { return { chunks: state.chunks, marks: state.marks }; }
}`,
  // A processor whose live state COMBINES reduced state (ticks, folded from durable 'tick' events)
  // with RUNTIME state (lastPokeMs — a plain field, NOT the reduce checkpoint, gone on eviction). A
  // 'poke' ephemeral event bumps the runtime field in processEvent and publishes its delta out of
  // band (the reduce never touches it). Proves reduced ⊕ runtime through ONE projection + ONE
  // revision chain (live-state-chains-client-side.e2e).
  "src/presence.js": `import { StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";
const contract = defineProcessorContract({
  slug: "presence",
  version: "1.0.0",
  description: "Reduced tick count beside a runtime lastPokeMs the reduce never sees.",
  stateSchema: z.object({ ticks: z.number().default(0) }),
  events: {},
  consumes: ["tick", "poke"],
  emits: [],
});
export class Presence extends StreamProcessorDurableObject {
  contract = contract;
  #lastPokeMs = 0; // RUNTIME: a field, not reduced state — reset to 0 on eviction, never refolded
  reduce({ event, state }) {
    if (event.type === "tick") return { ...state, ticks: state.ticks + 1 };
    // 'poke' is deliberately NOT folded — it drives a runtime field, not durable truth
  }
  processEvent({ event }) {
    if (event && event.type === "poke") {
      this.#lastPokeMs = Date.now();
      this.publishLiveState(); // out-of-band runtime delta: no reduce changed, we emit ourselves
    }
  }
  projectLiveState(state) { return { ticks: state.ticks, lastPokeMs: this.#lastPokeMs }; }
}`,
  "src/user-tally.js": `import { StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";
const contract = defineProcessorContract({
  slug: "user-tally",
  version: "1.0.0",
  description: "Counts committed events by type — the userspace SDK demo.",
  stateSchema: z.object({ counts: z.record(z.string(), z.number()).default({}) }),
  events: {},
  consumes: ["*"],
  emits: [],
});
export class UserTally extends StreamProcessorDurableObject {
  contract = contract;
  reduce({ event, state }) {
    return { counts: { ...state.counts, [event.type]: (state.counts[event.type] ?? 0) + 1 } };
  }
}`,
  // The facet-spine demo processor (was the platform's built-in `tally`): counts every durable event
  // by type. A userspace class like any other — there are no built-in processors.
  "src/tally.js": `import { StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";
const contract = defineProcessorContract({
  slug: "tally",
  version: "1.0.0",
  description: "Counts committed events by type — the facet-spine demo processor.",
  stateSchema: z.object({ counts: z.record(z.string(), z.number()).default({}) }),
  events: {},
  consumes: ["*"],
  emits: [],
});
export class Tally extends StreamProcessorDurableObject {
  contract = contract;
  reduce({ event, state }) {
    return { counts: { ...state.counts, [event.type]: (state.counts[event.type] ?? 0) + 1 } };
  }
}`,
  "src/site.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Site extends WorkerEntrypoint {
  async fetch(request) {
    if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].addEventListener("message", (e) => pair[1].send("site-echo:" + e.data));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("<!doctype html><title>dynamic site</title><h1>hello from a dynamic web capability</h1>", { headers: { "content-type": "text/html" } });
  }
}`,
};

/** Seed the named sources (short names: "site", "counter", …) into the project's kv. */
export async function seedSources(itx: any, names: string[]): Promise<void> {
  for (const n of names) {
    const key = `src/${n}.js`;
    if (!SOURCES[key]) throw new Error(`sources: no source ${key}`);
    await itx.invokeCapability(["itx", "kv", ["put", key, SOURCES[key]]]);
  }
}

/** The one spelling of "enable the fixture processor `name` from its seeded source": seeds it, then
 *  `enableProcessor(name, { source, className })` — a processor is a named facet whose
 *  `processEventBatch` is subscribed. `tally`, `chunky`, `presence`, `user-tally` are the fixtures. */
export async function enableFixtureProcessor(
  itx: any,
  name: string,
  className?: string,
): Promise<void> {
  const file = name === "user-tally" ? "user-tally" : name;
  await seedSources(itx, [file]);
  await itx.enableProcessor(name, {
    source: `itx.kv.get('src/${file}.js')`,
    className: className ?? FIXTURE_CLASS[name],
  });
}
const FIXTURE_CLASS: Record<string, string> = {
  tally: "Tally",
  chunky: "Chunky",
  presence: "Presence",
  "user-tally": "UserTally",
};
