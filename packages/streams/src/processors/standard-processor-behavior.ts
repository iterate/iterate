// Reusable contract and hook pieces that ordinary processors spread into their
// own contract and implementation. Standard processors register their public
// contract on the stream exactly once per processor version.

import { z } from "zod";
import type { EventCatalog, StreamEventInput } from "../shared/stream-processors.ts";
import type { ProcessorStream } from "../processor-runner.ts";
import { coreProcessorContract } from "./core/contract.ts";

export function buildProcessorRegisteredEvent(args: {
  contract: {
    slug: string;
    version: string;
    description: string;
    consumes: readonly string[];
    emits: readonly string[];
    events: EventCatalog;
  };
}): StreamEventInput<
  "events.iterate.com/stream/processor-registered",
  z.output<
    (typeof coreProcessorContract.events)["events.iterate.com/stream/processor-registered"]["payloadSchema"]
  >
> {
  return {
    type: "events.iterate.com/stream/processor-registered",
    idempotencyKey: `processor-registered:${args.contract.slug}:${args.contract.version}`,
    payload: {
      slug: args.contract.slug,
      version: args.contract.version,
      description: args.contract.description,
      consumes: [...args.contract.consumes],
      emits: [...args.contract.emits],
      ownedEvents: Object.entries(args.contract.events).map(([type, event]) => ({
        type,
        ...(event.description == null ? {} : { description: event.description }),
        ...(event.examples == null || event.examples.length === 0
          ? {}
          : { examples: [...event.examples] }),
      })),
    },
  };
}

export const standardProcessorBehavior = {
  stateShape: {
    hasRegisteredCurrentVersion: z.boolean().default(false),
  },
  initialState: {},
  processorDeps: [coreProcessorContract],
  consumes: ["events.iterate.com/stream/processor-registered"],
  emits: [
    "events.iterate.com/stream/processor-registered",
    "events.iterate.com/stream/error-occurred",
  ] as const,

  reduce<const State extends { hasRegisteredCurrentVersion: boolean }>(args: {
    state: State;
    event: { type: string; payload: unknown };
    contract: { slug: string; version: string };
  }): State {
    if (args.event.type !== "events.iterate.com/stream/processor-registered") {
      return args.state;
    }

    const event = coreProcessorContract.events[
      "events.iterate.com/stream/processor-registered"
    ].payloadSchema.parse(args.event.payload);
    if (event.slug !== args.contract.slug || event.version !== args.contract.version) {
      return args.state;
    }

    return {
      ...args.state,
      hasRegisteredCurrentVersion: true,
    };
  },

  afterAppend(args: {
    state: { hasRegisteredCurrentVersion: boolean };
    stream: ProcessorStream;
    keepAlive: (work: unknown) => void;
    contract: {
      slug: string;
      version: string;
      description: string;
      consumes: readonly string[];
      emits: readonly string[];
      events: EventCatalog;
    };
  }) {
    if (args.state.hasRegisteredCurrentVersion) return;

    args.keepAlive(
      args.stream.append({
        event: buildProcessorRegisteredEvent({ contract: args.contract }),
      }),
    );
  },
} as const;
