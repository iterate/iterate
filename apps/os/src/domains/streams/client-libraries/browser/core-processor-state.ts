// The slice of server stream state needed by the browser's local event database.
//
// `Stream.runtimeState()` deliberately types `coreProcessorState` as `unknown`
// (the full `CoreProcessorState` is server internals), so the browser runtime
// parses out just the two fields it reconciles against. Extra fields pass
// through unvalidated; a missing/mis-typed field fails loudly instead of
// silently reconciling against garbage.
//
// `identity.streamId` identifies one lifetime of the stream's event log. It
// stays the same across Durable Object restarts and changes when the stream is
// deleted and recreated, exactly when offsets restart from 1. `identity` is
// absent only for the empty fold before the `stream/created` event has
// committed. A browser cache cannot trust offset comparisons until it exists.

import { z } from "zod";

const BrowserCoreProcessorState = z
  .object({
    identity: z.object({ streamId: z.uuid() }).optional(),
    maxOffset: z.number().int().min(0).default(0),
  })
  .transform(({ identity, maxOffset }) => ({
    streamId: identity ? identity.streamId : undefined,
    maxOffset,
  }));

type BrowserCoreProcessorState = z.infer<typeof BrowserCoreProcessorState>;

export function parseBrowserCoreProcessorState(value: unknown): BrowserCoreProcessorState {
  return BrowserCoreProcessorState.parse(value);
}
