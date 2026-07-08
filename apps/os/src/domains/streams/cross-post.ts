import type { StreamEvent, StreamEventInput } from "./schemas.ts";

export type CrossPostProvenanceChain = NonNullable<
  NonNullable<StreamEvent["source"]>["crossPostedFrom"]
>;

export function buildCrossPostAppendInput(args: {
  event: StreamEvent;
  crossPostedFrom: CrossPostProvenanceChain;
  idempotencyKey: string;
}): StreamEventInput {
  return {
    type: args.event.type,
    ...(args.event.payload === undefined ? {} : { payload: args.event.payload }),
    ...(args.event.metadata === undefined ? {} : { metadata: args.event.metadata }),
    source: { ...args.event.source, crossPostedFrom: args.crossPostedFrom },
    idempotencyKey: args.idempotencyKey,
  };
}
