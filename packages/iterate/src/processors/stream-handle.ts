// The structural slice of the itx `Stream` surface the processor machinery
// (and processor implementations) depends on. Deliberately narrow: the
// platform's full `Stream` (generated into itx-api.generated.ts) satisfies it
// automatically, and a userspace host only has to provide these five methods
// — append (the emit lanes and the platform revival fact), readEvents
// (reduction rebuilds and catch-up self-pulls), getEvent/getEvents (point and
// page reads processors make from their hooks), and at (sibling-stream
// appendTo) — instead of faking the whole public stream API.
import type { StreamEvent, StreamEventInput } from "./schemas.ts";
import type { StreamEventReadInput } from "./rpc-types.ts";

/** One open journal read — page with `next()`, dispose when done
 * (`using pager = stream.readEvents(...)`). */
export interface ProcessorStreamPager {
  /** Returns [] when no newer matching page is currently available. */
  next(): Promise<StreamEvent[]>;
  [Symbol.dispose](): void;
}

/** The stream capabilities a processor host must supply — see module doc. */
export interface ProcessorStream {
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
  readEvents(args?: StreamEventReadInput): ProcessorStreamPager;
  getEvent(
    args: { offset: number; idempotencyKey?: never } | { idempotencyKey: string; offset?: never },
  ): Promise<StreamEvent | undefined>;
  getEvents(args?: StreamEventReadInput): Promise<StreamEvent[]>;
  at(path: string): ProcessorStream;
}
