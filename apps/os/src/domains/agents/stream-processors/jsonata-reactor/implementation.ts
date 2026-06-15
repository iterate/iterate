// Implements the "jsonata-reactor" processor.
//
// Reaction events are appended exactly as the rule's JSONata expression produces
// them (including any rule-provided idempotency keys); reaction evaluation and
// appends run under `blockProcessorWhile` because rules may produce reactions
// without idempotency keys, so the checkpoint must not advance past a failed
// reaction append.

import { z } from "zod";
import { getCompiledJsonata } from "@iterate-com/shared/streams/compiled-jsonata";
import type { StreamEvent } from "@iterate-com/shared/streams/stream-processors";
import {
  JsonataReactorProcessorContract,
  jsonataReactorEventTypes,
  type JsonataReactorState,
} from "./contract.ts";
import { StreamProcessor } from "~/domains/streams/engine/stream-processor.ts";

export { JsonataReactorProcessorContract } from "./contract.ts";

export type JsonataReactorProcessorContract = typeof JsonataReactorProcessorContract;

const AppendCommand = z.strictObject({
  streamPath: z.string().trim().min(1).optional(),
  event: z.strictObject({
    type: z.string().trim().min(1),
    payload: z.unknown(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    idempotencyKey: z.string().trim().min(1).optional(),
  }),
});

export class JsonataReactorProcessor extends StreamProcessor<JsonataReactorProcessorContract> {
  readonly contract = JsonataReactorProcessorContract;

  protected override reduce(
    args: Parameters<StreamProcessor<JsonataReactorProcessorContract>["reduce"]>[0],
  ): JsonataReactorState {
    const { event, state } = args;
    if (event.type !== jsonataReactorEventTypes.ruleConfigured) return state;
    return {
      ...state,
      rulesBySlug: {
        ...state.rulesBySlug,
        [event.payload.slug]: {
          matcher: event.payload.matcher,
          reactions: event.payload.reactions,
        },
      },
    };
  }

  protected override processEvent(
    args: Parameters<StreamProcessor<JsonataReactorProcessorContract>["processEvent"]>[0],
  ): void {
    const { event, state } = args;
    if (event.type === jsonataReactorEventTypes.ruleConfigured) return;
    args.blockProcessorWhile(() =>
      this.#appendJsonataReactorResults({ event: event as StreamEvent, state }),
    );
  }

  async #appendJsonataReactorResults(args: { event: StreamEvent; state: JsonataReactorState }) {
    for (const [slug, rule] of Object.entries(args.state.rulesBySlug)) {
      const matched = await getCompiledJsonata(rule.matcher).evaluate(args.event);
      if (!matched) continue;

      for (const reaction of rule.reactions) {
        const evaluated = await getCompiledJsonata(reaction.events).evaluate(args.event);
        const commands = parseAppendCommands({ evaluated, slug });
        for (const command of commands) {
          // The stream resolves relative `streamPath` values against its own
          // path, so cross-stream reactions keep working through the host's
          // stream context.
          await this.ctx.stream.append({
            event: command.event,
            ...(command.streamPath === undefined ? {} : { streamPath: command.streamPath }),
          });
        }
      }
    }
  }
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
