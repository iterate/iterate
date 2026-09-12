// src/client/presence/contract.ts — the presence processor's vocabulary (the triplet's contract:
// processor.ts is the pure reduce, durable-object.ts the loadable host).
//
// Its live state COMBINES reduced state (ticks, reduced from durable 'tick' events) with a RUNTIME
// field (lastPokeMs — held on the pure class, NOT the reduce checkpoint, gone on eviction): a 'poke'
// ephemeral bumps the field in processEvent, and the engine re-projects after the batch and emits the
// delta itself (the reduce never touches it).
import { z } from "zod";
import { defineProcessorContract } from "../../stream/processor.ts";

export const PresenceView = z.object({ ticks: z.number().default(0) });
export type PresenceView = z.infer<typeof PresenceView>;

// 'tick' is a durable event reduced into `ticks`; 'poke' is ephemeral and drives a runtime field only
// (`processEvent`, never reduced). Both carry no payload. The reduce/processEvent event union is
// derived from this contract's `consumes` — no hand-kept union.
export const PresenceContract = defineProcessorContract({
  slug: "presence",
  version: "1.0.0",
  description: "Reduced tick count beside a runtime lastPokeMs the reduce never sees.",
  stateSchema: PresenceView,
  events: {
    tick: {
      description: "A durable tick; increments the reduced count.",
      payloadSchema: z.object({}),
    },
    poke: {
      description: "An ephemeral poke; bumps the runtime lastPokeMs, never reduced.",
      payloadSchema: z.object({}),
      ephemeral: true,
    },
  },
  consumes: ["tick", "poke"],
  emits: [],
});
