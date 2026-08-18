// hello-files.ts — the v1 "file reader" behind `itx.files.read` — provides hello modules (no
// repo/bundler yet). A real repo-read-at-a-ref later slots in behind the SAME capability + source
// expressions. Its own module so BOTH hosts of the iterate-context processor (the Stream DO and
// the built-in ProcessorFacet) import it without a cycle.

export const HELLO_FILES: Record<string, string> = {
  "/hello.js": `export default (itx, name) => "hello " + (name ?? "world");`,
  "/counter.js": `import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject {
  async increment(by) { const n = ((await this.ctx.storage.get("n")) ?? 0) + by; await this.ctx.storage.put("n", n); return n; }
  async value() { return (await this.ctx.storage.get("n")) ?? 0; }
  async whoAmI() { return await this.env.ITX.invokeCapability("itx.whoami", []); }
  // A NESTED surface — proves the runner's deep dotted dispatch.
  get counters() {
    const self = this;
    return { async add(by) { return self.increment(by); } };
  }
}`,
  // A USERSPACE facet processor (duck-typed contract: configure/deliver/snapshot) — hosted as a
  // workerd facet on the Stream DO via enableProcessor(slug, { source, className }). It keeps its
  // own cursor + counts in its OWN facet storage. Drives are fire-and-forget and a delivered
  // batch is only a WAKE-UP: both deliver and snapshot catch up from the stream via env.ITX (the
  // parent stub) from the OWN cursor, so a dropped drive can never leave a gap.
  // THE LIVE-STATE CHATROOM — a mini-app durable-object class, NOT a stream processor: the SDK
  // helper makes mutation and notification inseparable; state() is the seed door.
  "/chatroom.js": `import { DurableObject } from "cloudflare:workers";
import { liveState } from "./processor.js";
export class Chatroom extends DurableObject {
  #chat = liveState(this.env.ITX, "chat", { messages: [] });
  post(from, text) {
    this.#chat.set({ messages: [...this.#chat.get().messages, { from, text }] });
    return { ok: true };
  }
  state() { return this.#chat.get(); }
}`,
  // Rich-value probe: proves the stateless run lane carries what Workers RPC carries — a Date
  // arrives as a Date and a client CALLBACK is callable from inside the confined isolate.
  "/probe.js": `export default async (itx, v, cb) => ({
  ctor: v?.constructor?.name ?? typeof v,
  cbResult: typeof cb === "function" ? await cb(7) : null,
});`,
  // THE RESTORE DEMO: a userspace durable object that STORES its live capability handle in its
  // own storage and uses the restored handle later — Kenton's persistent-stub machinery end to
  // end (storage.put accepts the ctx.exports-minted env.ITX because every chain member carries
  // allow_irrevocable_stub_storage; storage.get replays the restore chain on use).
  "/keeper.js": `import { DurableObject } from "cloudflare:workers";
export class Keeper extends DurableObject {
  async stash() {
    await this.ctx.storage.put("itx-cap", this.env.ITX);
    return { stashed: true };
  }
  async useStashed() {
    const cap = await this.ctx.storage.get("itx-cap");
    if (!cap) throw new Error("keeper: nothing stashed");
    return await cap.invokeCapability("itx.whoami", []);
  }
}`,
  // The stateless push consumer: a plain code cap the stream drives via a push subscription
  // (target "itx.digest.run"). No cursor of its own — the stream owns offsets/retries/halt.
  "/digest.js": `export default async (itx, events, window) => {
  const poison = events.find((e) => e.payload && e.payload.poison);
  if (poison) throw new Error("digest: refusing poison at offset " + poison.offset);
  const n = Number((await itx.kv.get("digested")) ?? 0) + events.length;
  await itx.kv.put("digested", String(n));
  return n;
};`,
  // A userspace processor consuming a NAMED ephemeral type ("chunk" — the voice-chunk shape):
  // naming the type is the opt-in; "*" never sweeps ephemerals.
  "/chunky.js": `import { StreamProcessor, defineProcessorContract, z } from "./processor.js";
const contract = defineProcessorContract({
  slug: "chunky",
  version: "1.0.0",
  description: "Counts named ephemeral chunks beside durable marks.",
  stateSchema: z.object({ chunks: z.number().default(0), marks: z.number().default(0) }),
  events: {},
  consumes: ["chunk", "mark"],
  emits: [],
});
export class Chunky extends StreamProcessor {
  contract = contract;
  reduce({ event, state }) {
    if (event.type === "chunk") return { ...state, chunks: state.chunks + 1 };
    if (event.type === "mark") return { ...state, marks: state.marks + 1 };
  }
  liveState(state) { return { chunks: state.chunks, marks: state.marks }; }
}`,
  // A userspace stream processor ON THE SDK: same contract helper, same schemas, same base
  // class as built-ins — the five rules, the cursor, refold and the read verbs all come free.
  "/user-tally.js": `import { StreamProcessor, defineProcessorContract, z } from "./processor.js";
const contract = defineProcessorContract({
  slug: "user-tally",
  version: "1.0.0",
  description: "Counts committed events by type — the userspace SDK demo.",
  stateSchema: z.object({ counts: z.record(z.string(), z.number()).default({}) }),
  events: {},
  consumes: ["*"],
  emits: [],
});
export class UserTally extends StreamProcessor {
  contract = contract;
  reduce({ event, state }) {
    return { counts: { ...state.counts, [event.type]: (state.counts[event.type] ?? 0) + 1 } };
  }
}`,
  // A fetch-serving stateless worker: an HTTP page AND a WebSocket upgrade (101) — the stand-in
  // for "a device presents a website with WebSocket functionality", reached on the fetch lane.
  "/site.js": `export default {
  async fetch(request) {
    if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].addEventListener("message", (e) => pair[1].send("site-echo:" + e.data));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("<!doctype html><title>dynamic site</title><h1>hello from a dynamic web capability</h1>", { headers: { "content-type": "text/html" } });
  }
};`,
};
