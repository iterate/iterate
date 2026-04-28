import {
  GenericEvent as GenericEventBase,
  GenericEventInput as GenericEventInputBase,
} from "@iterate-com/events-contract";
import { Callable } from "@iterate-com/shared/callable/types.ts";
import { z } from "zod";

/**
 * Persistent description of a codemode tool provider, keyed by `slug` (the
 * sandbox namespace, e.g. `slack` → `await slack.apiCall(...)`).
 *
 * Storing only `Callable`s keeps state JSON-serialisable and lets presets /
 * external systems author tool providers without holding live Worker bindings.
 */
const ToolProviderConfig = z.object({
  executeCallable: Callable,
  getTypesCallable: Callable.optional(),
});
type ToolProviderConfig = z.infer<typeof ToolProviderConfig>;

export const CodemodeProcessorState = z.object({
  /**
   * Set after the codemode prompt append has round-tripped back from the stream.
   * Wire dedupe uses `CODEMODE_PRIMER_IDEMPOTENCY_KEY`; this is just the reduced
   * "already appended" signal for future afterAppend calls.
   */
  hasAppendedCodemodePrompt: z.boolean().default(false),
  /**
   * Codemode tool providers, keyed by sandbox-namespace `slug`. Mutated by
   * `tool-provider-config-updated` events: a non-null `executeCallable`
   * upserts the slug, a null `executeCallable` deletes it.
   */
  toolProviders: z.record(z.string(), ToolProviderConfig).default({}),
});
export type CodemodeProcessorState = z.infer<typeof CodemodeProcessorState>;

function defineEventSchemas<const TType extends string, TPayload extends z.ZodType>(args: {
  type: TType;
  payload: TPayload;
}) {
  const input = GenericEventInputBase.extend({
    type: z.literal(args.type),
    payload: args.payload,
  });
  const event = GenericEventBase.extend(input.pick({ type: true, payload: true }).shape);
  return { event, input };
}

export const { event: CodemodeBlockAddedEvent, input: CodemodeBlockAddedEventInput } =
  defineEventSchemas({
    type: "codemode-block-added",
    payload: z.object({ script: z.string() }),
  });

export const { event: CodemodeResultAddedEvent, input: CodemodeResultAddedEventInput } =
  defineEventSchemas({
    type: "codemode-result-added",
    payload: z.object({
      result: z.unknown(),
      error: z.string().optional(),
      logs: z.array(z.string()).optional(),
      durationMs: z.number().int().nonnegative(),
    }),
  });

/**
 * Mutate `state.toolProviders[slug]`. A non-null `executeCallable` upserts the
 * entry; a null `executeCallable` removes the slug entirely. `slug` must be a
 * valid JS identifier — it becomes the namespace in the sandbox.
 */
export const { event: ToolProviderConfigUpdatedEvent, input: ToolProviderConfigUpdatedEventInput } =
  defineEventSchemas({
    type: "tool-provider-config-updated",
    payload: z.object({
      slug: z
        .string()
        .min(1)
        .regex(/^[a-zA-Z_$][a-zA-Z0-9_$]*$/, {
          message: "slug must be a valid JS identifier (becomes a sandbox namespace)",
        }),
      executeCallable: Callable.nullable(),
      getTypesCallable: Callable.optional().nullable(),
    }),
  });
