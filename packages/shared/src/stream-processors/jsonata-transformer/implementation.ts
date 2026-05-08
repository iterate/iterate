import jsonata from "jsonata";
import {
  implementProcessor,
  type ProcessorStreamApi,
  type StreamEventInput,
} from "../stream-processor.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";
import {
  JsonataTransformerProcessorContract,
  jsonataTransformerEventTypes,
  type JsonataTransformerState,
} from "./contract.ts";

type JsonataTransformerStreamApi = ProcessorStreamApi<typeof JsonataTransformerProcessorContract>;

const compiledExpressions = new Map<string, jsonata.Expression>();

export function createJsonataTransformerProcessor() {
  return implementProcessor(JsonataTransformerProcessorContract, {
    async afterAppend({ state, streamApi, event }) {
      await standardProcessorBehavior.afterAppend({
        contract: JsonataTransformerProcessorContract,
        state,
        streamApi,
      });

      await appendJsonataTransformResults({
        event,
        state,
        streamApi,
      });
    },
  });
}

export async function appendJsonataTransformResults(args: {
  event: unknown;
  state: JsonataTransformerState;
  streamApi: JsonataTransformerStreamApi;
}) {
  for (const [slug, transformer] of Object.entries(args.state.transformersBySlug)) {
    if (isSelfConfigurationEvent(args.event)) continue;

    const matched = await getCompiledJsonata(transformer.matcher).evaluate(args.event);
    if (!matched) continue;

    const transformed = await getCompiledJsonata(transformer.transform).evaluate(args.event);
    const event = parseTransformedEventInput({
      slug,
      transformed,
    });

    await appendDynamicTransformResult({ streamApi: args.streamApi, event });
  }
}

async function appendDynamicTransformResult(args: {
  streamApi: JsonataTransformerStreamApi;
  event: StreamEventInput;
}) {
  /**
   * JSONata transformers are unusual: their whole job is to emit an event whose
   * type is computed from the transform expression. That cannot be listed in
   * the static `emits` array without defeating the feature.
   *
   * Keep this escape hatch local and named. Ordinary processors should append
   * through `streamApi.append(...)` directly so `contract.emits` keeps them
   * honest.
   */
  const streamApi = args.streamApi as {
    append(appendArgs: { event: StreamEventInput }): Promise<unknown>;
  };
  await streamApi.append({ event: args.event });
}

function isSelfConfigurationEvent(event: unknown) {
  return (
    event != null &&
    typeof event === "object" &&
    "type" in event &&
    event.type === jsonataTransformerEventTypes.transformerConfigured
  );
}

function getCompiledJsonata(expression: string) {
  const cached = compiledExpressions.get(expression);
  if (cached != null) return cached;

  const compiled = jsonata(expression);
  compiledExpressions.set(expression, compiled);
  return compiled;
}

function parseTransformedEventInput(args: {
  slug: string;
  transformed: unknown;
}): StreamEventInput {
  if (args.transformed == null || typeof args.transformed !== "object") {
    throw new Error(`JSONata transformer ${args.slug} produced a non-object event input.`);
  }

  if (!("type" in args.transformed) || typeof args.transformed.type !== "string") {
    throw new Error(`JSONata transformer ${args.slug} produced an event input without a type.`);
  }

  return args.transformed as StreamEventInput;
}
