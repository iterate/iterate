// client/presence-processor-source.ts — THE presence processor's modules, the one source both the
// hosted demo (demo.tsx) and the e2e lane (e2e/support/sources.ts) load into a dynamic worker. Its
// live state COMBINES reduced state (ticks, reduced from durable 'tick' events) with RUNTIME state
// (lastPokeMs — a plain field on the pure class, NOT the reduce checkpoint, gone on eviction). A
// 'poke' ephemeral event bumps the runtime field in processEvent; the engine re-projects after the
// batch and emits the delta itself (the reduce never touches it). Two classes: the pure
// `PresenceProcessor`, and the one-line host `PresenceDurableObject` that `processors.enable`'s
// `className` names. Proves reduced ⊕ runtime through ONE projection + ONE revision chain
// (live-state-chains-client-side.e2e, specs/live-state-demo.spec).

/** The modules, literally (`"cap.js"` is the main module) — handed over inline at every load site. */
export const PRESENCE_PROCESSOR_SOURCE = {
  "cap.js": `import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";
const contract = defineProcessorContract({
  slug: "presence",
  version: "1.0.0",
  description: "Reduced tick count beside a runtime lastPokeMs the reduce never sees.",
  stateSchema: z.object({ ticks: z.number().default(0) }),  consumes: ["tick", "poke"],
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
};
