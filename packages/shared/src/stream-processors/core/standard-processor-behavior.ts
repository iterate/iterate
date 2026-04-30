import { z } from "zod";
import type { EventCatalog, StreamEventInput } from "../stream-processor.ts";
import {
  buildProcessorRegisteredEvent,
  CoreProcessorContract,
  CoreProcessorRegisteredEventType,
} from "./contract.ts";

/**
 * Base contract and implementation pieces that most processors should use
 * while the processor-composition model is still settling.
 *
 * This is the current home for the "base reduced state" every ordinary
 * processor wants. Right now that base state is only
 * `hasRegisteredCurrentVersion`, which tracks whether the processor's current
 * public contract has been announced on the stream. If more universal
 * processor state appears later, add it here before inventing a wider
 * composition abstraction.
 *
 * This is intentionally plain:
 *
 * - spread `stateShape` into the processor's `stateSchema`;
 * - merge `initialState` into the processor's `initialState` if needed;
 * - include `processorDeps`, `consumes`, and `emits` in the processor contract;
 * - call `reduce(...)` from the processor reducer;
 * - call `afterAppend(...)` from the backend implementation hook.
 *
 * Example contract usage:
 *
 * ```ts
 * defineProcessorContract({
 *   stateSchema: z.object({
 *     ...standardProcessorBehavior.stateShape,
 *     // processor-specific state...
 *   }),
 *   initialState: {
 *     ...standardProcessorBehavior.initialState,
 *   },
 *   processorDeps: [...standardProcessorBehavior.processorDeps],
 *   consumes: [
 *     ...standardProcessorBehavior.consumes,
 *     "events.iterate.com/agent/input-added",
 *   ],
 *   emits: [
 *     ...standardProcessorBehavior.emits,
 *     "events.iterate.com/agent/status-updated",
 *   ],
 * });
 * ```
 *
 * The behavior encoded here is "standard processors register their public
 * contract on the stream exactly once per processor version". The reduced
 * state tracks whether the current version's registration event has already
 * been observed. The `afterAppend` helper appends the registration event when
 * that flag is still false.
 *
 * This may become a small composed processor later. Keeping it as a bag for now
 * makes the repeated behavior visible without committing to a composition API.
 */
export const standardProcessorBehavior = {
  stateShape: {
    hasRegisteredCurrentVersion: z.boolean().default(false),
  },
  initialState: {},
  processorDeps: [CoreProcessorContract],
  consumes: ["events.iterate.com/core/stream-processor-registered"],
  emits: ["events.iterate.com/core/stream-processor-registered"],

  reduce<const State extends { hasRegisteredCurrentVersion: boolean }>(args: {
    state: State;
    event: {
      type: string;
      payload: unknown;
    };
    contract: {
      slug: string;
      version: string;
      description?: string;
    };
  }): State {
    if (args.event.type !== CoreProcessorRegisteredEventType) {
      return args.state;
    }

    const event = CoreProcessorContract.events[
      CoreProcessorRegisteredEventType
    ].payloadSchema.parse(args.event.payload);
    if (event.slug !== args.contract.slug || event.version !== args.contract.version) {
      return args.state;
    }

    return {
      ...args.state,
      hasRegisteredCurrentVersion: true,
    };
  },

  async afterAppend(args: {
    state: {
      hasRegisteredCurrentVersion: boolean;
    };
    streamApi: {
      append(appendArgs: {
        event: StreamEventInput<
          typeof CoreProcessorRegisteredEventType,
          z.output<
            (typeof CoreProcessorContract.events)[typeof CoreProcessorRegisteredEventType]["payloadSchema"]
          >
        >;
      }): Promise<unknown>;
    };
    contract: {
      slug: string;
      version: string;
      description: string;
      consumes: readonly string[];
      emits: readonly string[];
      events: EventCatalog;
    };
  }) {
    if (args.state.hasRegisteredCurrentVersion) {
      return;
    }

    await args.streamApi.append({
      event: buildProcessorRegisteredEvent({
        contract: args.contract,
      }),
    });
  },
} as const;
