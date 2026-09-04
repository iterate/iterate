// e2e/support/sources.ts — the demo module sources the E2E tests hand over INLINE. A source IS the
// worker's modules (module name → code, `"cap.js"` is the main module); nothing is seeded anywhere,
// there is no producer to fetch it. Each test names the fixture it uses:
//   ...source: SOURCES.site...

import type { WorkerSource } from "../../src/context/worker-loader.ts";

/** THE fixture sources, keyed by fixture NAME — each value is the worker's modules, handed over
 *  literally at every load site (`itx.workers.get({ source: SOURCES.probe })`, `facets.get(name, { source: … })`). */
export const SOURCES: Record<string, WorkerSource> = {
  counter: {
    "cap.js": `import { DurableObject } from "cloudflare:workers";
export class CounterDurableObject extends DurableObject {
  async increment(by) { const n = ((await this.ctx.storage.get("n")) ?? 0) + by; await this.ctx.storage.put("n", n); return n; }
  async value() { return (await this.ctx.storage.get("n")) ?? 0; }
  async whoAmI() { return await (await this.env.ITX.get()).whoami(); }
  get counters() {
    const self = this;
    return { async add(by) { return self.increment(by); } };
  }
}`,
  },
  chatroom: {
    "cap.js": `import { DurableObject } from "cloudflare:workers";
import { LiveState } from "./processor.js";
export class ChatroomDurableObject extends DurableObject {
  #chat = new LiveState({ append: (e) => this.env.ITX.get().append(e) }, "chat", { messages: [] });
  post(from, text) {
    this.#chat.set({ messages: [...this.#chat.get().messages, { from, text }] });
    return { ok: true };
  }
  state() { return this.#chat.snapshot(); }
}`,
  },
  probe: {
    "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Probe extends WorkerEntrypoint {
  async run(v, cb) {
    return {
      ctor: v?.constructor?.name ?? typeof v,
      cbResult: typeof cb === "function" ? await cb(7) : null,
    };
  }
}`,
  },
  keeper: {
    "cap.js": `import { DurableObject } from "cloudflare:workers";
export class KeeperDurableObject extends DurableObject {
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
  },
  // The stateless "project worker" shape: a WorkerEntrypoint whose processEventBatch(events, range) the
  // stream calls at-least-once from a cursor it keeps (resolving IS the ack; throwing ⇒ retry;
  // `retryable: false` ⇒ halt now).
  digest: {
    "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
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
  },
  chunky: {
    "cap.js": `import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";
const contract = defineProcessorContract({
  slug: "chunky",
  version: "1.0.0",
  description: "Counts named ephemeral chunks beside durable marks.",
  stateSchema: z.object({ chunks: z.number().default(0), marks: z.number().default(0) }),
  events: {},
  consumes: ["chunk", "mark"],
  emits: [],
});
class ChunkyProcessor extends StreamProcessor {
  contract = contract;
  reduce({ event, state }) {
    if (event.type === "chunk") return { ...state, chunks: state.chunks + 1 };
    if (event.type === "mark") return { ...state, marks: state.marks + 1 };
  }
  projectLiveState(state) { return { chunks: state.chunks, marks: state.marks }; }
}
export class ChunkyDurableObject extends StreamProcessorDurableObject {
  processor = new ChunkyProcessor();
}`,
  },
  // A processor whose live state COMBINES reduced state (ticks, reduced from durable 'tick' events)
  // with RUNTIME state (lastPokeMs — a plain field on the pure class, NOT the reduce checkpoint, gone
  // on eviction). A 'poke' ephemeral event bumps the runtime field in processEvent; the engine
  // re-projects after the batch and emits the delta itself (the reduce never touches it). Proves
  // reduced ⊕ runtime through ONE projection + ONE revision chain (live-state-chains-client-side.e2e).
  presence: {
    "cap.js": `import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";
const contract = defineProcessorContract({
  slug: "presence",
  version: "1.0.0",
  description: "Reduced tick count beside a runtime lastPokeMs the reduce never sees.",
  stateSchema: z.object({ ticks: z.number().default(0) }),
  events: {},
  consumes: ["tick", "poke"],
  emits: [],
});
class PresenceProcessor extends StreamProcessor {
  contract = contract;
  #lastPokeMs = 0; // RUNTIME: a field, not reduced state — reset to 0 on eviction, never re-reduced
  reduce({ event, state }) {
    if (event.type === "tick") return { ...state, ticks: state.ticks + 1 };
    // 'poke' is deliberately NOT reduced — it drives a runtime field, not durable truth
  }
  processEvent({ event }) {
    // no publish call: the engine re-projects after every batch and emits the delta itself
    if (event && event.type === "poke") this.#lastPokeMs = Date.now();
  }
  projectLiveState(state) { return { ticks: state.ticks, lastPokeMs: this.#lastPokeMs }; }
}
export class PresenceDurableObject extends StreamProcessorDurableObject {
  processor = new PresenceProcessor();
}`,
  },
  "user-tally": {
    "cap.js": `import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";
const contract = defineProcessorContract({
  slug: "user-tally",
  version: "1.0.0",
  description: "Counts committed events by type — the userspace SDK demo.",
  stateSchema: z.object({ counts: z.record(z.string(), z.number()).default({}) }),
  events: {},
  consumes: ["*"],
  emits: [],
});
class UserTallyProcessor extends StreamProcessor {
  contract = contract;
  reduce({ event, state }) {
    return { counts: { ...state.counts, [event.type]: (state.counts[event.type] ?? 0) + 1 } };
  }
}
export class UserTallyDurableObject extends StreamProcessorDurableObject {
  processor = new UserTallyProcessor();
}`,
  },
  // The facet-spine demo processor (was the platform's built-in `tally`): counts every durable event
  // by type. A userspace class like any other — there are no built-in processors.
  tally: {
    "cap.js": `import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";
const contract = defineProcessorContract({
  slug: "tally",
  version: "1.0.0",
  description: "Counts committed events by type — the facet-spine demo processor.",
  stateSchema: z.object({ counts: z.record(z.string(), z.number()).default({}) }),
  events: {},
  consumes: ["*"],
  emits: [],
});
class TallyProcessor extends StreamProcessor {
  contract = contract;
  reduce({ event, state }) {
    return { counts: { ...state.counts, [event.type]: (state.counts[event.type] ?? 0) + 1 } };
  }
}
export class TallyDurableObject extends StreamProcessorDurableObject {
  processor = new TallyProcessor();
}`,
  },
  // POLICY AS A FACET PROCESSOR: a token-bucket breaker that speaks core's control events. Every
  // durable non-control event spends one token, refilled from the EVENT's createdAt (pure,
  // replayable — a rebuild from the log lands on the same tokens); the crossing (tokens ≥ 0 → < 0)
  // trips the stream by appending stream/paused with the breaker's reason, keyed so a replay can never
  // double-pause. Core knows nothing about it — the pause check reads the reduced `paused` slice.
  breaker: {
    "cap.js": `import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";
const CAPACITY = 5; // tokens the bucket holds
const REFILL_PER_SECOND = 1; // tokens restored per second of EVENT time
const CONTROL = new Set([
  "events.iterate.com/stream/created",
  "events.iterate.com/stream/woken",
  "events.iterate.com/stream/paused",
  "events.iterate.com/stream/resumed",
]);
const contract = defineProcessorContract({
  slug: "breaker",
  version: "1.0.0",
  description: "A token-bucket breaker: one token per durable event, refilled by event time; crossing zero pauses the stream.",
  stateSchema: z.object({ tokens: z.number().default(CAPACITY), lastAtMs: z.number().default(0) }),
  events: {},
  consumes: ["*"],
  emits: ["events.iterate.com/stream/paused"],
});
class BreakerProcessor extends StreamProcessor {
  contract = contract;
  reduce({ event, state }) {
    if (CONTROL.has(event.type)) return; // the platform's records and the pause pair are free
    const atMs = Date.parse(event.createdAt);
    const refilled = state.lastAtMs
      ? Math.min(CAPACITY, state.tokens + ((atMs - state.lastAtMs) / 1000) * REFILL_PER_SECOND)
      : state.tokens;
    return { tokens: refilled - 1, lastAtMs: atMs };
  }
  processEvent({ event, state, previousState, append, blockProcessorWhile }) {
    if (!event || !(previousState.tokens >= 0 && state.tokens < 0)) return; // trip on the crossing only
    blockProcessorWhile(() =>
      append({
        type: "events.iterate.com/stream/paused",
        payload: { reason: "breaker: durable events exceeded the bucket" },
        idempotencyKey: this.idempotencyKey("trip", event),
      }),
    );
  }
}
export class BreakerDurableObject extends StreamProcessorDurableObject {
  processor = new BreakerProcessor();
}`,
  },
  // ── THE LIBRARY's fixtures: tiny servers a context reaches THROUGH ITS OWN EGRESS over the fetch
  // lane (`/expression[/<path>]?context=&itx=`), so `itx.connectToMcp/OpenApi/Capnweb` are proved end
  // to end with nothing outside the worker. Each is a WorkerEntrypoint whose `fetch` is the server. ──
  mcpServer: {
    "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
const TOOLS = [
  { name: "echo", description: "echo the arguments back", inputSchema: { type: "object" } },
  { name: "add", description: "a + b", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } },
];
const json = (v, init = {}) => new Response(JSON.stringify(v), { ...init, headers: { "content-type": "application/json", ...(init.headers || {}) } });
export default class McpServer extends WorkerEntrypoint {
  async fetch(request) {
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (request.method !== "POST") return new Response("MCP: POST only", { status: 405 });
    const body = await request.json();
    if (body.method === "initialize")
      return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture-mcp", version: "1" } } }, { headers: { "mcp-session-id": "fixture-session" } });
    // a session id handed out at initialize must ride on every later request
    if (request.headers.get("mcp-session-id") !== "fixture-session") return new Response("MCP: no session", { status: 400 });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") return json({ jsonrpc: "2.0", id: body.id, result: { tools: TOOLS } });
    if (body.method === "tools/call") {
      const { name, arguments: args } = body.params;
      if (name === "echo") return json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ echoed: args }) }] } });
      if (name === "add") return json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: String(args.a + args.b) }], structuredContent: { sum: args.a + args.b } } });
      return json({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "unknown tool " + name } });
    }
    return json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "unknown method " + body.method } });
  }
}`,
  },
  openapiServer: {
    "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
const SPEC = {
  openapi: "3.0.0",
  info: { title: "pets", version: "1" },
  servers: [],
  paths: {
    "/pets/{id}": { get: { operationId: "getPet", parameters: [{ name: "id", in: "path", required: true }] } },
    "/pets": {
      get: { operationId: "listPets", parameters: [{ name: "limit", in: "query" }] },
      post: { operationId: "createPet", requestBody: { content: { "application/json": {} } } },
    },
  },
};
const PETS = [{ id: 1, name: "rex" }, { id: 2, name: "tom" }, { id: 3, name: "kit" }];
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
export default class OpenApiServer extends WorkerEntrypoint {
  async fetch(request) {
    const url = new URL(request.url);
    // served over the fetch lane the path carries the lane prefix; the service sees a real path after it
    const path = url.pathname.replace(/^\\/expression/, "") || "/";
    if (request.method === "GET" && path === "/openapi.json") return json(SPEC);
    const pet = /^\\/pets\\/(\\d+)$/.exec(path);
    if (request.method === "GET" && pet) { const p = PETS.find((x) => x.id === Number(pet[1])); return p ? json(p) : json({ error: "no such pet" }, 404); }
    if (request.method === "GET" && path === "/pets") { const limit = Number(url.searchParams.get("limit") || PETS.length); return json(PETS.slice(0, limit)); }
    if (request.method === "POST" && path === "/pets") { const body = await request.json(); return json({ id: 4, ...body, created: true }, 201); }
    return json({ error: "not found: " + request.method + " " + path }, 404);
  }
}`,
  },
  capnwebServer: {
    "cap.js": `import { WorkerEntrypoint, RpcTarget } from "cloudflare:workers";
import { newWorkersRpcResponse } from "./processor.js";
class Counter extends RpcTarget {
  #n = 0;
  inc(by = 1) { this.#n += by; return this.#n; }
}
class Api extends RpcTarget {
  hello(name) { return "hello " + name; }
  counter() { return new Counter(); }
  headers() { return this.h; }
  constructor(h) { super(); this.h = h; }
}
export default class CapnwebServer extends WorkerEntrypoint {
  fetch(request) {
    return newWorkersRpcResponse(request, new Api({ authorization: request.headers.get("authorization") }));
  }
}`,
  },
  site: {
    "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
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
  },
};

/** The one spelling of "enable the fixture processor `name`": `enableProcessor(name, { source,
 *  className })` with the fixture's modules handed over inline — a processor is a named facet whose
 *  `processEventBatch` is subscribed. `className` names the HOST (`<Name>DurableObject`, the one-line
 *  `StreamProcessorDurableObject` subclass), never the pure `StreamProcessor` it hosts. `tally`,
 *  `chunky`, `presence`, `user-tally`, `breaker` are the fixtures. */
export async function enableFixtureProcessor(
  itx: any,
  name: string,
  className?: string,
): Promise<void> {
  await itx.enableProcessor(name, {
    source: SOURCES[name],
    className: className ?? FIXTURE_CLASS[name],
  });
}
const FIXTURE_CLASS: Record<string, string> = {
  tally: "TallyDurableObject",
  chunky: "ChunkyDurableObject",
  presence: "PresenceDurableObject",
  "user-tally": "UserTallyDurableObject",
  breaker: "BreakerDurableObject",
};
