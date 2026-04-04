import jsonata, { type Expression } from "jsonata";
import { z } from "zod";
import {
  EventInput as EventInputSchema,
  JsonataTransformerConfiguredEvent,
  type JsonataTransformerState,
} from "@iterate-com/events-contract";
import { defineBuiltinProcessor } from "./define-processor.ts";

/**
 * Event-driven JSONata transformer processor.
 *
 * Transformers are configured at runtime by appending "jsonata-transformer-configured"
 * events to a stream. Each transformer has a `matcher` (JSONata expression that must
 * return truthy for the event to be processed) and a `transform` (JSONata expression
 * that produces a new event to append).
 *
 * After every event is committed, each configured transformer is evaluated
 * independently — a failure in one transformer never blocks others.
 *
 * Compiled JSONata expressions are cached in-memory (LRU, up to 100 entries)
 * since the same expressions are re-evaluated on every incoming event.
 */
export const jsonataTransformerProcessor = defineBuiltinProcessor<JsonataTransformerState>(() => ({
  slug: "jsonata-transformer",
  initialState: { transformersBySlug: {} },

  reduce({ event, state }) {
    const configured = JsonataTransformerConfiguredEvent.safeParse(event);
    if (!configured.success) return state;

    return {
      transformersBySlug: {
        ...state.transformersBySlug,
        [configured.data.payload.slug]: {
          matcher: configured.data.payload.matcher,
          transform: configured.data.payload.transform,
        },
      },
    };
  },

  async afterAppend({ append, event, state }) {
    for (const [slug, transformer] of Object.entries(state.transformersBySlug)) {
      try {
        const matched = await getCompiledJsonata(transformer.matcher).evaluate(event);
        if (!matched) continue;

        const transformed = await getCompiledJsonata(transformer.transform).evaluate(event);
        const parsed = EventInputSchema.safeParse(transformed);
        if (!parsed.success) {
          console.error("[stream-do] jsonata transform produced an invalid event", {
            slug,
            eventType: event.type,
            issues: parsed.error.issues,
          });
          continue;
        }

        await append(parsed.data);
      } catch (error) {
        console.error("[stream-do] jsonata transformer failed", {
          slug,
          eventType: event.type,
          error,
        });
      }
    }
  },
}));

/** Zod refinement that validates a string is a parseable JSONata expression. */
export const JsonataExpression = z
  .string()
  .trim()
  .min(1)
  .superRefine((value, ctx) => {
    try {
      jsonata(value);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid JSONata expression: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

const jsonataCache = new Map<string, Expression>();

function getCompiledJsonata(expression: string) {
  const cached = jsonataCache.get(expression);
  if (cached) return cached;

  if (jsonataCache.size >= 100) {
    const oldestKey = jsonataCache.keys().next().value;
    if (oldestKey) jsonataCache.delete(oldestKey);
  }

  const compiled = jsonata(expression);
  jsonataCache.set(expression, compiled);
  return compiled;
}
