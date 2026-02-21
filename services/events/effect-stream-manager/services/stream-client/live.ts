/**
 * Live implementation of StreamClient
 */
import { HttpClient, HttpClientRequest } from "@effect/platform";
import { Effect, Layer, Schema, Stream } from "effect";

import { Event, type EventInput, type Offset, type StreamPath } from "../../domain.ts";
import { StreamClient, StreamClientConfig, StreamClientError } from "./service.ts";

// -------------------------------------------------------------------------------------
// Live implementation
// -------------------------------------------------------------------------------------

export const make = (config: StreamClientConfig) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    const subscribe = (input: {
      path: StreamPath;
      after?: Offset;
      live?: boolean;
    }): Stream.Stream<Event, StreamClientError> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const params = new URLSearchParams();
          if (input.after) params.set("offset", input.after);
          if (input.live) params.set("live", "true");
          const query = params.toString();
          const url = query
            ? `${config.baseUrl}/api/streams/${input.path}?${query}`
            : `${config.baseUrl}/api/streams/${input.path}`;
          const response = yield* client.execute(HttpClientRequest.get(url));

          return response.stream.pipe(
            Stream.mapError((cause) => StreamClientError.make({ operation: "subscribe", cause })),
            Stream.decodeText(),
            Stream.mapConcat(parseSSE),
          );
        }).pipe(
          Effect.mapError((cause) => StreamClientError.make({ operation: "subscribe", cause })),
        ),
      );

    const append = (input: { path: StreamPath; event: EventInput }) =>
      client
        .execute(
          HttpClientRequest.post(`${config.baseUrl}/api/streams/${input.path}`).pipe(
            HttpClientRequest.bodyUnsafeJson(input.event),
          ),
        )
        .pipe(
          Effect.asVoid,
          Effect.mapError((cause) => StreamClientError.make({ operation: "append", cause })),
        );

    return { subscribe, append };
  });

export const liveLayer = (
  config: StreamClientConfig,
): Layer.Layer<StreamClient, never, HttpClient.HttpClient> =>
  Layer.effect(StreamClient, make(config));

// -------------------------------------------------------------------------------------
// SSE parsing
// -------------------------------------------------------------------------------------

function parseSSE(chunk: string): Array<Event> {
  const events: Array<Event> = [];
  const lines = chunk.split("\n");

  let currentEvent: string | null = null;
  let currentData: string | null = null;

  for (const line of lines) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7);
    } else if (line.startsWith("data: ")) {
      currentData = line.slice(6);
    } else if (line === "" && currentData !== null) {
      // Empty line = end of event
      if (currentEvent === "data") {
        try {
          const parsed = JSON.parse(currentData);
          const decoded = Schema.decodeUnknownSync(Event)(parsed);
          events.push(decoded);
        } catch (e) {
          console.warn(
            "[stream-client] Failed to parse SSE event:",
            e,
            "raw:",
            currentData.slice(0, 200),
          );
        }
      }
      currentEvent = null;
      currentData = null;
    }
  }

  return events;
}
