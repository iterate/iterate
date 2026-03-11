/**
 * Simple SSE helpers for durable-stream
 */
import { HttpServerResponse } from "@effect/platform";
import { Schema, Stream } from "effect";

import { Event } from "./domain.ts";

export interface SseEvent {
  readonly event: string;
  readonly data: string;
  readonly id?: string;
}

const SSE_MESSAGE_EVENT = "message";

/**
 * Encode an event to SSE format
 */
export const encode = (event: SseEvent): string => {
  let out = "";
  if (event.id !== undefined) {
    out += `id: ${event.id}\n`;
  }
  out += `event: ${event.event}\n`;
  out += `data: ${event.data}\n`;
  return out + "\n";
};

/**
 * Encode an Event to standard SSE message format with proper Schema encoding.
 * This ensures Option fields are properly transformed (e.g., Option -> null).
 */
export const message = (event: Event): string => {
  const encoded = Schema.encodeSync(Event)(event);
  return encode({ event: SSE_MESSAGE_EVENT, data: JSON.stringify(encoded) });
};

/**
 * @deprecated Use `message` instead.
 */
export const data = message;

/**
 * Encode a control event
 */
export const control = (payload: unknown): string =>
  encode({ event: "control", data: JSON.stringify(payload) });

/**
 * Create an SSE response from a stream of encoded SSE strings
 */
export const response = <E>(stream: Stream.Stream<string, E>) =>
  HttpServerResponse.stream(Stream.encodeText(stream), {
    contentType: "text/event-stream",
    headers: {
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });

/**
 * Create an SSE response from a stream of events
 */
export const fromEvents = <E, R>(
  stream: Stream.Stream<SseEvent, E, R>,
): Stream.Stream<string, E, R> => Stream.map(stream, encode);
