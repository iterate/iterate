// e2e/support/sources.ts — the demo module sources the E2E tests hand over INLINE. A source IS the
// worker's files (path → code, the entry `worker.ts` or `worker.js`); nothing is seeded anywhere,
// there is no producer to fetch it. Each test names the fixture it uses:
//   ...source: SOURCES.site...

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { WorkerSource } from "iterate/api";

/** The presence facet as its TypeScript source files, handed over exactly like user code: the host
 *  (durable-object.ts) is the entry, its siblings ride under their own names. */
const presenceFile = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../src/client/presence/${name}`, import.meta.url).href),
    "utf8",
  );
const PRESENCE_SOURCE: WorkerSource = {
  "worker.ts": presenceFile("durable-object.ts"),
  "processor.ts": presenceFile("processor.ts"),
  "contract.ts": presenceFile("contract.ts"),
};

/** THE fixture sources, keyed by fixture NAME — each value is the worker's modules, handed over
 *  literally at every load site (`itx.workers.get({ source: SOURCES.probe })`, `facets.get(name, { source: … })`). */
export const SOURCES: Record<string, WorkerSource> = {
  chatroom: {
    "worker.js": `import { FacetDurableObject, LiveState, withItx } from "iterate/sdk";
export class ChatroomDurableObject extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "post", "state"];
  #chat = new LiveState({ append: (e) => withItx(this.env.ITX, (itx) => itx.append(e)) }, "chat", { messages: [] });
  post(from, text) {
    this.#chat.set({ messages: [...this.#chat.get().messages, { from, text }] });
    return { ok: true };
  }
  state() { return this.#chat.snapshot(); }
}`,
  },
  probe: {
    "worker.js": `import { WorkerEntrypoint } from "cloudflare:workers";
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
    "worker.js": `import { FacetDurableObject } from "iterate/sdk";
export class KeeperDurableObject extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "stash", "useStashed", "started"];
  startedAt = Date.now();
  started() { return this.startedAt; }
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
    "worker.js": `import { WorkerEntrypoint } from "cloudflare:workers";
import { withItx } from "iterate/sdk";
export default class Digest extends WorkerEntrypoint {
  async processEventBatch(events, range) {
    const poison = events.find((e) => e.payload && e.payload.poison);
    if (poison)
      throw Object.assign(new Error("digest: refusing poison at offset " + poison.offset), {
        retryable: false, // the stamped-flag doctrine: never-retryable halts NOW, not in 30 min
      });
    return withItx(this.env.ITX, async (itx) => {
      const n = Number((await itx.kv.get("digested")) ?? 0) + events.length;
      await itx.kv.put("digested", String(n));
      return n;
    });
  }
}`,
  },
  chunky: {
    "worker.js": `import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "iterate/sdk";
const contract = defineProcessorContract({
  slug: "chunky",
  version: "1.0.0",
  description: "Counts named ephemeral chunks beside durable marks.",
  stateSchema: z.object({ chunks: z.number().default(0), marks: z.number().default(0) }),
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
  // The presence processor (reduced ⊕ runtime) — the hosted demo's source, shared (src/client).
  presence: PRESENCE_SOURCE,
  "user-tally": {
    "worker.js": `import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "iterate/sdk";
const contract = defineProcessorContract({
  slug: "user-tally",
  version: "1.0.0",
  description: "Counts committed events by type — the userspace SDK demo.",
  stateSchema: z.object({ counts: z.record(z.string(), z.number()).default({}) }),
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
  // The facet-spine demo processor: counts every durable event
  // by type. A userspace class like any other — there are no built-in processors.
  tally: {
    "worker.js": `import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "iterate/sdk";
const contract = defineProcessorContract({
  slug: "tally",
  version: "1.0.0",
  description: "Counts committed events by type — the facet-spine demo processor.",
  stateSchema: z.object({ counts: z.record(z.string(), z.number()).default({}) }),
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
  // trips the stream by appending itx/paused with the breaker's reason, keyed so a replay can never
  // double-pause. Core knows nothing about it — the pause check reads the reduced `paused` slice.
  breaker: {
    "worker.js": `import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "iterate/sdk";
const CAPACITY = 5; // tokens the bucket holds
const REFILL_PER_SECOND = 1; // tokens restored per second of EVENT time
const CONTROL = new Set([
  "events.iterate.com/itx/created",
  "events.iterate.com/itx/woken",
  "events.iterate.com/itx/paused",
  "events.iterate.com/itx/resumed",
]);
const contract = defineProcessorContract({
  slug: "breaker",
  version: "1.0.0",
  description: "A token-bucket breaker: one token per durable event, refilled by event time; crossing zero pauses the stream.",
  stateSchema: z.object({ tokens: z.number().default(CAPACITY), lastAtMs: z.number().default(0) }),
  consumes: ["*"],
  emits: ["events.iterate.com/itx/paused"],
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
        type: "events.iterate.com/itx/paused",
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
  // THE AI LINTER (a project's own, userspace): a processor on a GitHub connection's log
  // (`/integrations/github/<connection>`) that answers each pull request opened, readied or pushed
  // to with one Check Run. It reads the PR's files and posts the verdict with the connection's
  // installation token (`getSecret("/secrets/github-<connection>")` through `itx.fetch`, the
  // context's egress), asks `itx.ai` for the verdict, and skips a commit that already has its run
  // (`external_id`), so a redelivery lints nothing twice. Enabled on a log with history, it lints
  // none of it: whoever installs it appends `pr-linter-installed` beside the enable, and it lints
  // only the webhooks after that event (enabling replays the whole log).
  prLinter: {
    "worker.js": `import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "iterate/sdk";
const WEBHOOK = "events.iterate.com/github/webhook-received";
const INSTALLED = "pr-linter-installed";
const CHECK = "Iterate GitHub AI linter";
const MODEL = "@cf/meta/llama-3.1-8b-instruct";
const contract = defineProcessorContract({
  slug: "pr-linter",
  version: "1.0.0",
  description: "Lints each pull request a GitHub connection's webhooks announce, as one Check Run.",
  stateSchema: z.object({ installedAt: z.number().nullable().default(null) }),
  consumes: [WEBHOOK, INSTALLED],
  emits: [],
});
class PrLinterProcessor extends StreamProcessor {
  contract = contract;
  constructor(withItx) { super(); this.withItx = withItx; }
  reduce({ event, state }) {
    if (event.type === INSTALLED && state.installedAt === null) return { installedAt: event.offset };
  }
  processEvent({ event, state, blockProcessorWhile }) {
    if (state.installedAt === null || !event || event.type !== WEBHOOK) return;
    const { delivery: github, body } = event.payload;
    const pr = body.pull_request;
    if (github.name !== "pull_request" || !pr || pr.draft || pr.state !== "open") return;
    if (!["opened", "ready_for_review", "synchronize"].includes(body.action)) return;
    blockProcessorWhile(() => this.lint(event.path, body));
  }
  async lint(path, body) {
    const connection = path.split("/").pop();
    const repo = body.repository.url; // the API's repository URL, the fake's on a preview
    const headers = {
      accept: "application/vnd.github+json",
      authorization: 'Bearer getSecret("/secrets/github-' + connection + '", { field: "accessToken" })',
      "user-agent": "iterate-pr-linter",
    };
    const github = async (url, init = {}) => {
      const response = await this.withItx((itx) => itx.fetch(new Request(url, { ...init, headers: { ...headers, ...init.headers } })));
      if (!response.ok) throw new Error("GitHub answered " + response.status + " to " + url + ": " + (await response.text()));
      return response.json();
    };
    const sha = body.pull_request.head.sha;
    const externalId = "pr-linter:" + body.repository.full_name + "#" + body.pull_request.number + "@" + sha;
    const existing = await github(repo + "/commits/" + sha + "/check-runs?check_name=" + encodeURIComponent(CHECK));
    if ((existing.check_runs || []).some((run) => run.external_id === externalId)) return;
    const files = await github(repo + "/pulls/" + body.pull_request.number + "/files");
    const patch = files.map((file) => "--- " + file.filename + "\\n" + (file.patch || "")).join("\\n");
    const answer = await this.withItx((itx) =>
      itx.ai.run(MODEL, {
        messages: [
          { role: "system", content: 'Review this diff. Answer JSON: {"conclusion":"success"|"neutral","summary":string}.' },
          { role: "user", content: patch },
        ],
      }),
    );
    let verdict = { conclusion: "neutral", summary: "The linter could not read the model's answer." };
    try { verdict = { ...verdict, ...JSON.parse(answer.response) }; } catch {}
    await github(repo + "/check-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: CHECK,
        head_sha: sha,
        status: "completed",
        conclusion: verdict.conclusion === "success" ? "success" : "neutral",
        external_id: externalId,
        output: { title: CHECK, summary: verdict.summary },
      }),
    });
  }
}
export class PrLinterDurableObject extends StreamProcessorDurableObject {
  processor = new PrLinterProcessor((call) => this.withItx(call));
}`,
  },
  // A capnweb server as a LOADED WORKER, served behind a project host: pins the SDK's
  // `newWorkersRpcResponse` export (library-connectors.e2e) and, through `path()`,
  // that the host's `/<path>` reaches the service verbatim.
  capnwebServer: {
    "worker.js": `import { WorkerEntrypoint, RpcTarget } from "cloudflare:workers";
import { newWorkersRpcResponse } from "iterate/sdk";
class Api extends RpcTarget {
  #path;
  constructor(path) { super(); this.#path = path; }
  hello(name) { return "hello " + name; }
  path() { return this.#path; }
}
export default class CapnwebServer extends WorkerEntrypoint {
  fetch(request) {
    return newWorkersRpcResponse(request, new Api(new URL(request.url).pathname));
  }
}`,
  },
  site: {
    "worker.js": `import { WorkerEntrypoint } from "cloudflare:workers";
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

/** The one spelling of "enable the fixture processor `name`": `processors.enable(name, { source,
 *  className })` with the fixture's modules handed over inline — a processor is a named facet whose
 *  `processEventBatch` is subscribed. `className` names the HOST (`<Name>DurableObject`, the one-line
 *  `StreamProcessorDurableObject` subclass), never the pure `StreamProcessor` it hosts. `tally`,
 *  `user-tally`, `breaker` are the fixtures enabled this way (`chunky` and `presence` are enabled
 *  with their `consumes` spelled out at the one site each has). */
export async function enableFixtureProcessor(itx: any, name: string): Promise<void> {
  await itx.processors.enable(name, { source: SOURCES[name], className: FIXTURE_CLASS[name] });
}
const FIXTURE_CLASS: Record<string, string> = {
  tally: "TallyDurableObject",
  "user-tally": "UserTallyDurableObject",
  breaker: "BreakerDurableObject",
};
