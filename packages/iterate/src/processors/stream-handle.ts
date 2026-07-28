// The structural slice of the itx `Stream` surface the processor machinery
// (and processor implementations) depends on. Deliberately narrow: the
// platform's full `Stream` (generated into itx-api.generated.ts) satisfies it
// automatically, and a userspace host only has to provide these five methods
// — append (processor output and the platform revival fact), readEvents
// (reduction rebuilds and catch-up self-pulls), getEvent/getEvents (point and
// page reads processors make from their hooks), and at (sibling-stream
// appendTo) — instead of faking the whole public stream API.
import type { StreamEvent, StreamEventInput } from "./schemas.ts";
import type {
  StreamEventPage,
  StreamEventReadInput,
  StreamWakeDeliverySettlementReport,
} from "./rpc-types.ts";

/**
 * Resolve the path accepted by `stream.at(path)`. Absolute paths start at the
 * stream root; relative paths start at `basePath`; `..` may climb only as far
 * as the root. Keeping this next to {@link ProcessorStream} lets processor
 * appends decide whether a resolved destination is their own stream without
 * relying on RPC-target object identity.
 */
export function resolveStreamPath(basePath: string, streamPath: string): string {
  const segments = streamPath.startsWith("/") ? [] : basePath.split("/").filter(Boolean);
  for (const segment of streamPath.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        throw new Error(
          `stream path "${streamPath}" escapes the stream root (resolved from "${basePath}")`,
        );
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

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
  /**
   * Append only if this path still names the observed stream lifetime. The
   * identity check and append happen in one stream turn, so a delete/recreate
   * cannot slip between them.
   */
  appendIfStreamId(args: { streamId: string; events: StreamEventInput[] }): Promise<StreamEvent[]>;
  /**
   * Read events together with the stream lifetime that owns their offsets.
   * Processor cursors must never consume a bare event array.
   */
  getEventPage(args?: StreamEventReadInput): Promise<StreamEventPage>;
  readEvents(args?: StreamEventReadInput): ProcessorStreamPager;
  getEvent(
    args: { offset: number; idempotencyKey?: never } | { idempotencyKey: string; offset?: never },
  ): Promise<StreamEvent | undefined>;
  getEvents(args?: StreamEventReadInput): Promise<StreamEvent[]>;
  at(path: string): ProcessorStream;
  /** Transitional receiver for the retired direct-settlement rollout. */
  settleWakeDelivery?(report: StreamWakeDeliverySettlementReport): void;
}
