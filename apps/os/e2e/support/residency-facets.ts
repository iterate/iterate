// e2e/support/residency-facets.ts — THE LOADED FACETS the residency rows host, shared by the two
// suites that run them: e2e/context-residency.e2e.test.ts asserts what the platform code decides
// (a reset, recorded or not, and whether a facet is still running at the end), and the opt-in
// perf/context-residency.perf.test.ts times what Cloudflare decides (how long a facet the context no
// longer holds keeps running, whether a context stays resident under traffic). Each facet writes
// what it did into its OWN storage, which survives every reset, so a row reads it after the fact
// without keeping anything resident in between.

/** When the facet started: the construction time its live state's revision counts from
 *  (`liveSnapshot().rev` is that moment × 4096, stream/processor.ts `LiveState`). */
export const facetStartedAt = async (facet: any): Promise<number> =>
  Math.floor((await facet.liveSnapshot()).rev / 4096);

/** A careless facet that keeps its `env.ITX` answer and beats a timer into its own storage every
 *  5 s. `beat()` answers the facet's clock at the first beat; `beats()` answers the record: how many
 *  beats, the last, the instance's start, and the error a beat threw (a beat that throws stops the
 *  timer, which must not read as a stop from outside). */
export const HEARTBEAT_SOURCE = {
  // oxlint-disable-next-line iterate/no-raw-itx-get -- the careless keep IS the subject: the sweep must stop a facet that keeps its env.ITX answer
  "cap.js": `import { FacetDurableObject } from "./processor.js";
export class HeartbeatDurableObject extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "beat", "beats"];
  kept = [];
  startedAt = Date.now();
  async beat() {
    this.kept.push(await this.env.ITX.get().whoami());
    this.ctx.storage.kv.put("startedAt", this.startedAt);
    const tick = () => {
      try {
        this.ctx.storage.kv.put("beats", (this.ctx.storage.kv.get("beats") ?? 0) + 1);
        this.ctx.storage.kv.put("lastBeat", Date.now());
      } catch (error) {
        this.ctx.storage.kv.put("beatError", String(error));
        return;
      }
      setTimeout(tick, 5_000);
    };
    tick();
    return Date.now();
  }
  beats() {
    const kv = this.ctx.storage.kv;
    return {
      beats: kv.get("beats") ?? 0,
      lastBeat: kv.get("lastBeat") ?? null,
      startedAt: kv.get("startedAt") ?? null,
      beatError: kv.get("beatError") ?? null,
    };
  }
}`,
};

/** A careless facet that calls its own context every 5 s (an append of `chatter`) and keeps every
 *  answer: it keeps that context resident, so no birth resets it. */
export const CHATTY_SOURCE = {
  // oxlint-disable-next-line iterate/no-raw-itx-get -- the careless keep IS the subject: a facet that keeps every scope and answer from its own calls
  "cap.js": `import { FacetDurableObject } from "./processor.js";
export class ChattyDurableObject extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "chatter"];
  kept = [];
  chatter() {
    const tick = async () => {
      const itx = this.env.ITX.get();
      this.kept.push(itx, await itx.append({ type: "chatter" }));
      setTimeout(tick, 5_000);
    };
    void tick();
    return "chattering";
  }
}`,
};

/** A careless mini-app: its LiveState sink takes a fresh `env.ITX` scope per `set` and releases
 *  neither it nor the append's answer. Its live state's revision (`rev`, the start time × 4096) names
 *  the instance. The careful one is support/sources.ts `chatroom`. */
export const CARELESS_CHATROOM_SOURCE = {
  // oxlint-disable-next-line iterate/no-raw-itx-get -- the careless sink IS the subject: neither the context nor the facet may stay running on it
  "cap.js": `import { FacetDurableObject, LiveState } from "./processor.js";
export class ChatroomDurableObject extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "post", "state"];
  #chat = new LiveState({ append: (e) => this.env.ITX.get().append(e) }, "chat", { messages: [] });
  post(from, text) {
    this.#chat.set({ messages: [...this.#chat.get().messages, { from, text }] });
    return { ok: true };
  }
  state() { return this.#chat.snapshot(); }
}`,
};

/** A plain facet serving HTTP; its instance id is the page. */
export const SITE_SOURCE = {
  "cap.js": `import { FacetDurableObject } from "./processor.js";
export class SiteDurableObject extends FacetDurableObject {
  id = crypto.randomUUID();
  fetch() { return new Response(this.id); }
}`,
};

/** A careless facet that holds a claim for `holdMs`, then releases it — the voice call that hangs up
 *  after a quiet minute. It keeps its `env.ITX` answer and beats a timer into its own storage;
 *  `start` answers the facet's clock at the start, `beats()` the last beat and when the release
 *  landed. */
export const RELEASER_SOURCE = {
  // oxlint-disable-next-line iterate/no-raw-itx-get -- the careless keep IS the subject: a claimed facet that keeps its env.ITX answer
  "cap.js": `import { FacetDurableObject, withItx } from "./processor.js";
export class ReleaserDurableObject extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "start", "beats"];
  kept = [];
  async start(holdMs) {
    const name = this.ctx.props.name;
    await withItx(this.env.ITX, (itx) => itx.processors.claim(name, Date.now() + 600_000));
    const itx = this.env.ITX.get();
    this.kept.push(itx, await itx.whoami());
    const beat = () => { this.ctx.storage.kv.put("lastBeat", Date.now()); setTimeout(beat, 5_000); };
    beat();
    setTimeout(async () => {
      await withItx(this.env.ITX, (itx) => itx.processors.claim(name, null));
      this.ctx.storage.kv.put("releasedAt", Date.now());
    }, holdMs);
    return Date.now();
  }
  beats() {
    return { lastBeat: this.ctx.storage.kv.get("lastBeat") ?? null, releasedAt: this.ctx.storage.kv.get("releasedAt") ?? null };
  }
}`,
};

/** A processor that sleeps in the background until `sleep`'s deadline (its `createdAt` + `ms`),
 *  then appends `slept` naming the instance that slept. It keeps the SDK's rule 3
 *  (stream/processor.ts): what is owed lives in STATE, so the at-head pass of a revive restarts a
 *  sleep an instance that died still owed — the work finishes whichever instance runs it, and
 *  `slept.payload.startedAt` says which one did. */
export const SLEEPER_SOURCE = {
  "cap.js": `import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";
const contract = defineProcessorContract({
  slug: "sleeper",
  version: "1.0.0",
  description: "Sleeps in the background until a deadline, then says which instance slept.",
  stateSchema: z.object({ owed: z.record(z.string(), z.number()).default({}) }),
  consumes: ["sleep", "slept"],
  emits: ["slept"],
});
class SleeperProcessor extends StreamProcessor {
  contract = contract;
  startedAt = Date.now();
  sleeping = new Set();
  reduce({ event, state }) {
    if (event.type === "sleep")
      return { owed: { ...state.owed, [event.offset]: Date.parse(event.createdAt) + event.payload.ms } };
    if (event.type === "slept") {
      const { [event.payload.sleepOffset]: _done, ...owed } = state.owed;
      return { owed };
    }
    return state;
  }
  processEvent({ state, append, runInBackground }) {
    for (const [offset, until] of Object.entries(state.owed)) {
      if (this.sleeping.has(offset)) continue;
      this.sleeping.add(offset);
      runInBackground(async () => {
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, until - Date.now())));
        await append({
          type: "slept",
          payload: { sleepOffset: Number(offset), startedAt: this.startedAt },
          idempotencyKey: "slept:" + offset,
        });
      });
    }
  }
}
export class SleeperDurableObject extends StreamProcessorDurableObject {
  processor = new SleeperProcessor();
}`,
};
