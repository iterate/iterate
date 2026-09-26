/// <reference types="node" />
// stream/test-support.ts — the REAL Stream over node:sqlite for apps/os's unit tests. The processor
// harness (`reduceProcessor`, `memoryStream`, `memoryStorage`, `settle`) and the node:sqlite Durable
// Object storage are the SDK's, `iterate/stream/test-support`: every processor author tests with them.
import type { StreamEvent, StreamEventInput } from "iterate/stream/processor";
import { nodeSqliteDurableObjectStorage } from "iterate/stream/test-support";
import { Stream } from "./stream.ts";

/** The REAL Stream over a fresh node:sqlite store, for tests that read its core reduced state the
 *  way the DO does: `events` collects every committed event (the `onCommit` fan-out), in offset
 *  order. No birth record, so the first append lands at offset 1. */
export function nodeSqliteStream() {
  const events: StreamEvent[] = [];
  const stream = new Stream({
    storage: nodeSqliteDurableObjectStorage(),
    path: "/",
    projectId: "prj_t",
    onCommit: (fresh) => void events.push(...fresh),
  });
  return { stream, events };
}

/** The REAL Stream, appended to as the DO appends: every event stamped before it commits (the DO
 *  refuses an unstamped one). An event that names no `source` was written by this context's own
 *  code, as `stampCaller` stamps a call that started here (src/caller.ts); one that names a source
 *  is a test about that writer. */
export class StampedStream extends Stream {
  override append(...events: StreamEventInput[]): StreamEvent[] {
    return super.append(
      ...events.map((event) => ({ ...event, source: event.source || { origin: this.path } })),
    );
  }
}
