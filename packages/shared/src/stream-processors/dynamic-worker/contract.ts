import { z } from "zod";
import {
  assertNever,
  defineProcessorContract,
  reduceProcessorEvents,
  type StreamEvent,
} from "../stream-processor.ts";
import { CoreProcessorRegisteredEventType } from "../core/contract.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";

export const dynamicWorkerEventTypes = {
  workerConfigured: "events.iterate.com/dynamic-worker/worker-configured",
  envVarSet: "events.iterate.com/dynamic-worker/env-var-set",
} as const;

const WorkerModules = z.record(z.string(), z.string());

const DynamicWorkerConfig = z.object({
  compatibilityDate: z.string().trim().min(1).default("2026-02-05"),
  compatibilityFlags: z.array(z.string().trim().min(1)).default([]),
  mainModule: z.string().trim().min(1).default("worker.js"),
  modules: WorkerModules,
});
export type DynamicWorkerConfig = z.infer<typeof DynamicWorkerConfig>;

/**
 * Shared dynamic worker processor contract.
 *
 * This processor only reduces worker configuration into serializable state.
 * Any concrete runner that wants to launch code from this state must inject its
 * own Worker loader / sandbox / process manager into that runner.
 */
export const DynamicWorkerProcessorContract = defineProcessorContract({
  slug: "dynamic-worker",
  version: "0.1.0",
  description: "Tracks dynamically configured worker modules for a stream.",
  stateSchema: z.object({
    ...standardProcessorBehavior.stateShape,
    envVarsByKey: z.record(z.string(), z.string()).default({}),
    workersBySlug: z.record(z.string(), DynamicWorkerConfig).default({}),
  }),
  initialState: {
    ...standardProcessorBehavior.initialState,
  },
  processorDeps: [...standardProcessorBehavior.processorDeps],
  events: {
    [dynamicWorkerEventTypes.workerConfigured]: {
      description: "Adds or updates one dynamic worker config.",
      payloadSchema: z.object({
        slug: z.string().trim().min(1),
        compatibilityDate: z.string().trim().min(1).optional(),
        compatibilityFlags: z.array(z.string().trim().min(1)).optional(),
        mainModule: z.string().trim().min(1).optional(),
        modules: WorkerModules.optional(),
        script: z.string().optional(),
      }),
    },
    [dynamicWorkerEventTypes.envVarSet]: {
      description: "Sets a string environment variable visible to configured workers.",
      payloadSchema: z.object({
        key: z.string().trim().min(1),
        value: z.string(),
      }),
    },
  },
  consumes: [
    ...standardProcessorBehavior.consumes,
    dynamicWorkerEventTypes.workerConfigured,
    dynamicWorkerEventTypes.envVarSet,
  ],
  emits: [...standardProcessorBehavior.emits],
  reduce({ contract, state, event }) {
    const nextState = standardProcessorBehavior.reduce({ state, event, contract });

    switch (event.type) {
      case CoreProcessorRegisteredEventType:
        return nextState;
      case dynamicWorkerEventTypes.workerConfigured:
        return {
          ...nextState,
          workersBySlug: {
            ...nextState.workersBySlug,
            [event.payload.slug]: normalizeDynamicWorkerConfig(event.payload),
          },
        };
      case dynamicWorkerEventTypes.envVarSet:
        return {
          ...nextState,
          envVarsByKey: {
            ...nextState.envVarsByKey,
            [event.payload.key]: event.payload.value,
          },
        };
      default:
        return assertNever(event);
    }
  },
});

export function reduceDynamicWorkerEvents(args: {
  events: readonly StreamEvent[];
  state?: DynamicWorkerState;
}) {
  return reduceProcessorEvents({
    contract: DynamicWorkerProcessorContract,
    events: args.events,
    state: args.state,
  });
}

export function normalizeDynamicWorkerConfig(input: {
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  mainModule?: string;
  modules?: Record<string, string>;
  script?: string;
}): DynamicWorkerConfig {
  const mainModule = input.mainModule ?? "worker.js";
  const modules =
    input.script == null
      ? (input.modules ?? {})
      : {
          "processor.js": input.script,
          [mainModule]: [
            'import processor from "./processor.js";',
            "export default processor;",
          ].join("\n"),
        };

  return DynamicWorkerConfig.parse({
    compatibilityDate: input.compatibilityDate,
    compatibilityFlags: input.compatibilityFlags,
    mainModule,
    modules,
  });
}

export type DynamicWorkerState = z.infer<typeof DynamicWorkerProcessorContract.stateSchema>;
