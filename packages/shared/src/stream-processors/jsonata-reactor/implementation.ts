import { z } from "zod";
import { getCompiledJsonata } from "../../streams/compiled-jsonata.ts";
import {
  implementProcessor,
  type ProcessorStreamApi,
  type StreamEvent,
  type StreamEventInput,
} from "../stream-processor.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";
import {
  JsonataReactorProcessorContract,
  jsonataReactorEventTypes,
  type JsonataReactorState,
} from "./contract.ts";

type JsonataReactorStreamApi = ProcessorStreamApi<typeof JsonataReactorProcessorContract>;

const AppendCommand = z.strictObject({
  streamPath: z.string().trim().min(1).optional(),
  event: z.strictObject({
    type: z.string().trim().min(1),
    payload: z.unknown(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    idempotencyKey: z.string().trim().min(1).optional(),
  }),
});

export function createJsonataReactorProcessor() {
  return implementProcessor(JsonataReactorProcessorContract, {
    async afterAppend({ state, streamApi, event }) {
      await standardProcessorBehavior.afterAppend({
        contract: JsonataReactorProcessorContract,
        state,
        streamApi,
      });

      await appendJsonataReactorResults({
        event: event as StreamEvent,
        state,
        streamApi,
      });
    },
  });
}

export async function appendJsonataReactorResults(args: {
  event: StreamEvent;
  state: JsonataReactorState;
  streamApi: JsonataReactorStreamApi;
}) {
  if (args.event.type === jsonataReactorEventTypes.ruleConfigured) return;

  for (const [slug, rule] of Object.entries(args.state.rulesBySlug)) {
    const matched = await getCompiledJsonata(rule.matcher).evaluate(args.event);
    if (!matched) continue;

    for (const reaction of rule.reactions) {
      const evaluated = await getCompiledJsonata(reaction.events).evaluate(args.event);
      const commands = parseAppendCommands({ evaluated, slug });
      for (const command of commands) {
        await appendDynamicReaction({
          command,
          streamApi: args.streamApi,
        });
      }
    }
  }
}

async function appendDynamicReaction(args: {
  command: z.infer<typeof AppendCommand>;
  streamApi: JsonataReactorStreamApi;
}) {
  const streamApi = args.streamApi as {
    append(appendArgs: { event: StreamEventInput; streamPath?: string }): Promise<unknown>;
  };
  await streamApi.append({
    event: args.command.event,
    streamPath: args.command.streamPath,
  });
}

function parseAppendCommands(args: { evaluated: unknown; slug: string }) {
  const rawCommands = Array.isArray(args.evaluated) ? args.evaluated : [args.evaluated];
  return rawCommands.map((command) => {
    const parsed = AppendCommand.safeParse(command);
    if (parsed.success) return parsed.data;

    throw new Error(
      `JSONata reactor rule ${args.slug} produced an invalid append command: ${z.prettifyError(parsed.error)}`,
    );
  });
}
