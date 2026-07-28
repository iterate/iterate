// The slice of server stream state needed by the browser's local event database.
//
// `Stream.runtimeState()` deliberately types `coreProcessorState` as `unknown`
// (the full `CoreProcessorState` is server internals), so the browser runtime
// parses out just the two fields it reconciles against. Extra fields pass
// through unvalidated; a missing/mis-typed field fails loudly instead of
// silently reconciling against garbage.
//
// `streamId` identifies one lifetime of the stream's event log. It stays the
// same across Durable Object restarts and changes when the stream is deleted
// and recreated, exactly when offsets restart from 1. It is optional only for
// the empty fold before the `stream/created` event has committed. A browser
// cache cannot trust offset comparisons until that ID exists.

import { z } from "zod";

const BrowserCoreProcessorState = z.object({
  streamId: z.uuid().optional(),
  maxOffset: z.number().int().min(0).default(0),
});

type BrowserCoreProcessorState = z.infer<typeof BrowserCoreProcessorState>;

export function parseBrowserCoreProcessorState(value: unknown): BrowserCoreProcessorState {
  return BrowserCoreProcessorState.parse(value);
}

/**
 * The wider slice stream NAVIGATION views (tree browser, breadcrumb child
 * pickers) render: the reconcile fields plus the immediate child paths and
 * event count from the server's core reduced state. Kept separate from
 * `BrowserCoreProcessorState` so the browser runtime's server-state check stays
 * exactly the two fields it depends on.
 */
export const BrowserCoreStreamTreeState = BrowserCoreProcessorState.extend({
  childPaths: z.array(z.string().trim().min(1)).default([]),
  eventCount: z.number().int().min(0).default(0),
});

export type BrowserCoreStreamTreeState = z.infer<typeof BrowserCoreStreamTreeState>;

export function parseBrowserCoreStreamTreeState(value: unknown): BrowserCoreStreamTreeState {
  return BrowserCoreStreamTreeState.parse(value);
}
