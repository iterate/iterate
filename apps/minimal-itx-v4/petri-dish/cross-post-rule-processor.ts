/**
 * Petri dish only. This file is outside `src/` and is not imported by the worker.
 *
 * The real version would live in core: `rule-configured` reduces into core
 * state, then core cross-posts matching committed events after append.
 */

import { z } from "zod";
import type { StreamEventInput } from "../src/types.ts";
import {
  defineProcessorContract,
  StreamProcessor,
} from "../src/domains/streams/stream-processor.ts";

export const CrossPostRuleProcessorContract = defineProcessorContract({
  slug: "stream-cross-post-rules",
  version: "0.0.0-petri-dish",
  description: "Sketches stream-local cross-post rules before moving them into core.",
  stateSchema: z.object({
    rulesById: z
      .record(
        z.string(),
        z.object({
          path: z.string().trim().min(1),
          eventTypes: z.array(z.string().trim().min(1)),
        }),
      )
      .default({}),
  }),
  events: {
    "events.iterate.com/stream/rule-configured": {
      description: "Configures or replaces a local stream rule.",
      payloadSchema: z.object({
        ruleId: z.string().trim().min(1),
        type: z.literal("cross-post"),
        path: z.string().trim().min(1),
        eventTypes: z.array(z.string().trim().min(1)).min(1),
      }),
    },
  },
  consumes: ["*", "events.iterate.com/stream/rule-configured"],
  emits: [],
});

export class CrossPostRuleProcessor extends StreamProcessor<
  typeof CrossPostRuleProcessorContract,
  {
    projectId: string | null;
    path: string;
  }
> {
  readonly contract = CrossPostRuleProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof CrossPostRuleProcessorContract>["reduce"]>[0]) {
    switch (event.type) {
      case "events.iterate.com/stream/rule-configured":
        return {
          ...state,
          rulesById: {
            ...state.rulesById,
            [event.payload.ruleId]: {
              path: event.payload.path,
              eventTypes: event.payload.eventTypes,
            },
          },
        };
      default:
        return state;
    }
  }

  protected override processEvent({
    event,
    runInBackground,
    state,
  }: Parameters<StreamProcessor<typeof CrossPostRuleProcessorContract>["processEvent"]>[0]) {
    if (event.type === "events.iterate.com/stream/rule-configured") return;
    if (event.source != null && "crossPost" in event.source) return;

    const matchingRules = Object.entries(state.rulesById).filter(([, rule]) =>
      rule.eventTypes.includes(event.type),
    );
    if (matchingRules.length === 0) return;

    runInBackground(async () => {
      await Promise.all(
        matchingRules.map(([ruleId, rule]) => {
          const { createdAt, offset, ...copy } = event;
          return this.stream.at(rule.path).append({
            ...copy,
            source: {
              ...copy.source,
              crossPost: {
                ruleId,
                from: {
                  projectId: this.deps.projectId,
                  path: this.deps.path,
                  offset,
                  type: event.type,
                  createdAt,
                },
              },
            },
            idempotencyKey: `cross-post:${ruleId}:${this.deps.projectId ?? "global"}:${this.deps.path}:${offset}`,
          } as StreamEventInput);
        }),
      );
    });
  }
}
