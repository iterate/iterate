/**
 * Structural stream/event types for the events components.
 *
 * These components render events produced by the OS stream engine, but
 * `packages/ui` must stay standalone (it cannot import app source), so the
 * shapes are declared locally. They deliberately describe only what the
 * components actually consume; any engine event envelope that carries these
 * fields is compatible.
 */
import type { StreamEvent } from "./stream-processor-fold/stream-event.ts";

/** Stream identifier in leading-slash form (`"/"`, `"/agents/foo"`). */
export type StreamPath = string;

/**
 * Committed stream event tagged with the path of the stream it lives on.
 * Feed renderers and the agent-ui reducer key off `streamPath`; callers whose
 * envelopes omit it backfill the field before reducing.
 */
export type Event = StreamEvent & {
  streamPath: StreamPath;
};
