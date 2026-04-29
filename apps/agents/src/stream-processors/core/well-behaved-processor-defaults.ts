import { z } from "zod";
import type { EventCatalog, StreamEventInput } from "@iterate-com/shared/stream-processors";
import {
  CoreProcessorContract,
  CoreProcessorRegisteredEventType,
  createProcessorRegisteredInput,
} from "./contract.ts";

/**
 * A temporary bag of contract and implementation pieces that most processors
 * should use while the processor-composition model is still settling.
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
 *     ...wellBehavedProcessorDefaults.stateShape,
 *     // processor-specific state...
 *   }),
 *   initialState: {
 *     ...wellBehavedProcessorDefaults.initialState,
 *   },
 *   processorDeps: [...wellBehavedProcessorDefaults.processorDeps],
 *   consumes: [
 *     ...wellBehavedProcessorDefaults.consumes,
 *     "events.iterate.com/agent/input-added",
 *   ],
 *   emits: [
 *     ...wellBehavedProcessorDefaults.emits,
 *     "events.iterate.com/agent/status-updated",
 *   ],
 * });
 * ```
 *
 * The behavior encoded here is "well-behaved processors register their public
 * contract on the stream exactly once per processor version". The reduced
 * state tracks whether the current version's registration event has already
 * been observed. The `afterAppend` helper appends the registration event when
 * that flag is still false.
 *
 * This may become a small composed processor later. Keeping it as a bag for now
 * makes the repeated behavior visible without committing to a composition API.
 */
export const wellBehavedProcessorDefaults = {
  stateShape: {
    hasRegisteredCurrentVersion: z.boolean().default(false),
  },
  initialState: {},
  processorDeps: [CoreProcessorContract],
  consumes: ["events.iterate.com/core/processor/registered"],
  emits: ["events.iterate.com/core/processor/registered"],

  reduce<const State extends { hasRegisteredCurrentVersion: boolean }>(args: {
    state: State;
    event: {
      type: string;
      payload: unknown;
    };
    contract: {
      slug: string;
      version: string;
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
      event: createProcessorRegisteredInput({
        contract: args.contract,
      }),
    });
  },
} as const;
