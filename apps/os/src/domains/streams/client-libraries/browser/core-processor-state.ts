// The slice of the server stream's core reduced state the browser mirror needs.
//
// `Stream.runtimeState()` deliberately types `coreProcessorState` as `unknown`
// (the full `CoreProcessorState` is server internals), so the browser runtime
// parses out just the two fields it reconciles against. Extra fields pass
// through unvalidated; a missing/mis-typed field fails loudly instead of
// silently reconciling against garbage.
//
// INCARNATION IDENTITY: `createdAt` is the commit timestamp of the stream's
// `events.iterate.com/stream/created` event (always offset 1). It is stable for
// the stream's whole lifetime and changes exactly when the stream's storage was
// deleted and recreated (offsets restart from 1) — which is the reincarnation
// the mirror must detect before trusting an offset comparison. The other
// candidate, core state's `incarnationId` (from `stream/woken`), is NOT
// suitable: it changes on every Durable Object restart while the event log —
// and therefore the mirror — remains perfectly valid. `createdAt` is optional
// because a stream that has not committed its `created` event yet has no
// incarnation; the store treats "no incarnation recorded" as untrustworthy and
// rebuilds, which is always safe for a cache.

import { z } from "zod";

export const BrowserCoreProcessorState = z.object({
  createdAt: z.string().optional(),
  maxOffset: z.number().int().min(0).default(0),
});

export type BrowserCoreProcessorState = z.infer<typeof BrowserCoreProcessorState>;

export function parseBrowserCoreProcessorState(value: unknown): BrowserCoreProcessorState {
  return BrowserCoreProcessorState.parse(value);
}

/**
 * The wider slice stream NAVIGATION views (tree browser, breadcrumb child
 * pickers) render: the reconcile fields plus the immediate child paths and
 * event count from the server's core reduced state. Kept separate from
 * `BrowserCoreProcessorState` so the mirror runtime's reconcile contract stays
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
