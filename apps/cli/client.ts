/**
 * HTTP Client for Event Streams
 *
 * Provides typed client operations for stream append and subscribe.
 * Handles SSE parsing for subscriptions.
 */
import * as Sse from "@effect/experimental/Sse";
import * as HttpBody from "@effect/platform/HttpBody";
import * as HttpClient from "@effect/platform/HttpClient";
import type * as HttpClientError from "@effect/platform/HttpClientError";
import * as HttpClientRequest from "@effect/platform/HttpClientRequest";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import { DaemonService, defaultDaemonConfig } from "./daemon.ts";

/** Client configuration */
export interface ClientConfig {
  /** Server URL (e.g., "http://localhost:3000") */
  readonly serverUrl: string;
}

/** Error for client operations */
export class ClientError extends Error {
  readonly _tag = "ClientError";
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "ClientError";
  }
}

// Branded types for stream operations
export const StreamName = Schema.String.pipe(Schema.nonEmptyString(), Schema.brand("StreamName"));
export type StreamName = typeof StreamName.Type;

export const Offset = Schema.String.pipe(Schema.brand("Offset"));
export type Offset = typeof Offset.Type;

export const OFFSET_START = "-1" as Offset;

export const EventStreamId = Schema.String.pipe(
  Schema.nonEmptyString(),
  Schema.brand("EventStreamId"),
);
export type EventStreamId = typeof EventStreamId.Type;

// Event schema
export class Event extends Schema.Class<Event>("Event")({
  offset: Offset,
  eventStreamId: EventStreamId,
  data: Schema.Unknown,
  createdAt: Schema.String,
}) {}

/** Stream client service interface */
export interface StreamClient {
  /** Append data to a stream, returns the created event */
  readonly append: (opts: { name: StreamName; data: unknown }) => Effect.Effect<Event, ClientError>;

  /** Subscribe to a stream, returns event stream */
  readonly subscribe: (opts: {
    name: StreamName;
    offset?: Offset;
  }) => Effect.Effect<Stream.Stream<Event, ClientError>, ClientError>;

  /** Subscribe to all streams (live events only, no history) */
  readonly subscribeAll: () => Effect.Effect<Stream.Stream<Event, ClientError>, ClientError>;

  /** Get historic events from a stream (one-shot, no live subscription) */
  readonly get: (opts: {
    name: StreamName;
    offset?: Offset;
    limit?: number;
  }) => Effect.Effect<ReadonlyArray<Event>, ClientError>;

  /** List all streams */
  readonly list: () => Effect.Effect<ReadonlyArray<StreamName>, ClientError>;

  /** Delete a stream */
  readonly delete: (opts: { name: StreamName }) => Effect.Effect<void, ClientError>;
}

/** Create client with explicit server URL */
export const makeStreamClient = (
  config: ClientConfig,
): Effect.Effect<StreamClient, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const baseClient = yield* HttpClient.HttpClient;
    const client = baseClient.pipe(
      HttpClient.mapRequest((request) =>
        request.pipe(HttpClientRequest.prependUrl(config.serverUrl)),
      ),
    );
    const clientOk = HttpClient.filterStatusOk(client);

    /** Map HTTP errors to ClientError with helpful messages */
    const mapRequestError = (error: HttpClientError.RequestError): ClientError => {
      if (error.reason === "Transport") {
        return new ClientError(`Cannot connect to ${config.serverUrl} - server not reachable`);
      }
      return new ClientError(`Request failed: ${error.message}`);
    };

    const append = (opts: { name: StreamName; data: unknown }): Effect.Effect<Event, ClientError> =>
      Effect.gen(function* () {
        const request = HttpClientRequest.post(`/streams/${opts.name}`, {
          body: HttpBody.unsafeJson({ data: opts.data }),
        });

        const response = yield* clientOk.execute(request).pipe(
          Effect.flatMap((r) => r.json),
          Effect.scoped,
          Effect.catchTags({
            RequestError: (error) => Effect.fail(mapRequestError(error)),
            ResponseError: (error) =>
              Effect.fail(new ClientError(`HTTP ${error.response.status}`, error.response.status)),
          }),
        );

        return yield* Schema.decodeUnknown(Event)(response).pipe(
          Effect.mapError((e) => new ClientError(`Invalid event: ${e}`)),
        );
      });

    const subscribe = (opts: {
      name: StreamName;
      offset?: Offset;
    }): Effect.Effect<Stream.Stream<Event, ClientError>, ClientError> => {
      const offsetParam = opts.offset
        ? `?offset=${opts.offset === OFFSET_START ? "-1" : opts.offset}`
        : "";
      const url = `/streams/${opts.name}${offsetParam}`;

      const request = HttpClientRequest.get(url);

      // Return a stream that handles the SSE connection
      const eventStream: Stream.Stream<Event, ClientError> = clientOk.execute(request).pipe(
        Effect.map((r) => r.stream),
        Stream.unwrapScoped,
        Stream.decodeText(),
        Stream.pipeThroughChannel(Sse.makeChannel()),
        Stream.mapEffect((event) =>
          Schema.decode(Schema.parseJson(Event))(event.data).pipe(
            Effect.mapError((e) => new ClientError(`Parse error: ${e}`)),
          ),
        ),
        Stream.catchTags({
          RequestError: (error) => Stream.fail(mapRequestError(error)),
          ResponseError: (error) =>
            Stream.fail(new ClientError(`HTTP ${error.response.status}`, error.response.status)),
        }),
      );

      return Effect.succeed(eventStream);
    };

    const subscribeAll = (): Effect.Effect<Stream.Stream<Event, ClientError>, ClientError> => {
      const request = HttpClientRequest.get("/streams/all");

      // Return a stream that handles the SSE connection
      const eventStream: Stream.Stream<Event, ClientError> = clientOk.execute(request).pipe(
        Effect.map((r) => r.stream),
        Stream.unwrapScoped,
        Stream.decodeText(),
        Stream.pipeThroughChannel(Sse.makeChannel()),
        Stream.mapEffect((event) =>
          Schema.decode(Schema.parseJson(Event))(event.data).pipe(
            Effect.mapError((e) => new ClientError(`Parse error: ${e}`)),
          ),
        ),
        Stream.catchTags({
          RequestError: (error) => Stream.fail(mapRequestError(error)),
          ResponseError: (error) =>
            Stream.fail(new ClientError(`HTTP ${error.response.status}`, error.response.status)),
        }),
      );

      return Effect.succeed(eventStream);
    };

    const get = (opts: {
      name: StreamName;
      offset?: Offset;
      limit?: number;
    }): Effect.Effect<ReadonlyArray<Event>, ClientError> =>
      Effect.gen(function* () {
        const params = new URLSearchParams();
        if (opts.offset) params.set("offset", opts.offset === OFFSET_START ? "-1" : opts.offset);
        if (opts.limit) params.set("limit", String(opts.limit));
        const queryString = params.toString();
        const url = `/streams/${opts.name}/events${queryString ? `?${queryString}` : ""}`;

        const request = HttpClientRequest.get(url);

        const response = yield* clientOk.execute(request).pipe(
          Effect.flatMap((r) => r.json),
          Effect.scoped,
          Effect.catchTags({
            RequestError: (error) => Effect.fail(mapRequestError(error)),
            ResponseError: (error) =>
              Effect.fail(new ClientError(`HTTP ${error.response.status}`, error.response.status)),
          }),
        ) as Effect.Effect<{ events: ReadonlyArray<unknown> }, ClientError>;

        return yield* Effect.all(
          response.events.map((e) =>
            Schema.decodeUnknown(Event)(e).pipe(
              Effect.mapError((err) => new ClientError(`Invalid event: ${err}`)),
            ),
          ),
        );
      });

    const list = (): Effect.Effect<ReadonlyArray<StreamName>, ClientError> =>
      Effect.gen(function* () {
        const request = HttpClientRequest.get(`/streams`);

        const response = yield* clientOk.execute(request).pipe(
          Effect.flatMap((r) => r.json),
          Effect.scoped,
          Effect.catchTags({
            RequestError: (error) => Effect.fail(mapRequestError(error)),
            ResponseError: (error) =>
              Effect.fail(new ClientError(`HTTP ${error.response.status}`, error.response.status)),
          }),
        ) as Effect.Effect<{ streams: ReadonlyArray<StreamName> }, ClientError>;

        return response.streams;
      });

    const deleteStream = (opts: { name: StreamName }): Effect.Effect<void, ClientError> =>
      Effect.gen(function* () {
        const request = HttpClientRequest.del(`/streams/${opts.name}`);

        yield* client.execute(request).pipe(
          Effect.scoped,
          Effect.asVoid,
          Effect.catchTags({
            RequestError: (error) => Effect.fail(mapRequestError(error)),
            ResponseError: (error) => {
              // 204 is success for delete
              if (error.response.status === 204) return Effect.void;
              return Effect.fail(
                new ClientError(`HTTP ${error.response.status}`, error.response.status),
              );
            },
          }),
        );
      });

    return {
      append,
      subscribe,
      subscribeAll,
      get,
      list,
      delete: deleteStream,
    } satisfies StreamClient;
  });

/** Stream client service with auto-daemon support */
export class StreamClientService extends Effect.Service<StreamClientService>()(
  "@iterate/cli/StreamClient",
  {
    effect: Effect.gen(function* () {
      const daemon = yield* DaemonService;
      const httpClient = yield* HttpClient.HttpClient;

      /** Resolve server URL from env, flag, or daemon. Starts daemon if needed and waits for ready. */
      const resolveServerUrl: Effect.Effect<string, ClientError> = Effect.gen(function* () {
        // Check env var first
        const envUrl = process.env.EVENT_STREAM_URL;
        if (envUrl) {
          return envUrl;
        }

        // Check if daemon is running
        const daemonUrl = yield* daemon
          .getServerUrl()
          .pipe(Effect.catchAll(() => Effect.succeed(Option.none<string>())));
        if (Option.isSome(daemonUrl)) {
          return daemonUrl.value;
        }

        // Auto-start daemon
        yield* Effect.log("No server found, starting daemon...");
        const pid = yield* daemon
          .start()
          .pipe(Effect.mapError((e) => new ClientError(`Failed to start daemon: ${e.message}`)));
        yield* Effect.log(`Daemon started (PID ${pid}), waiting for ready...`);

        const serverUrl = `http://localhost:${defaultDaemonConfig.port}`;

        // Wait a bit for server to come up
        yield* Effect.sleep("1 second");

        yield* Effect.log("Daemon ready");

        return serverUrl;
      });

      const withClient = <A, E>(
        fn: (client: StreamClient) => Effect.Effect<A, E>,
      ): Effect.Effect<A, E | ClientError> =>
        Effect.gen(function* () {
          const serverUrl = yield* resolveServerUrl;
          const client = yield* makeStreamClient({ serverUrl }).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
          return yield* fn(client);
        });

      return {
        append: (opts: { name: StreamName; data: unknown }) => withClient((c) => c.append(opts)),
        subscribe: (opts: { name: StreamName; offset?: Offset }) =>
          withClient((c) => c.subscribe(opts)),
        subscribeAll: () => withClient((c) => c.subscribeAll()),
        get: (opts: { name: StreamName; offset?: Offset; limit?: number }) =>
          withClient((c) => c.get(opts)),
        list: () => withClient((c) => c.list()),
        delete: (opts: { name: StreamName }) => withClient((c) => c.delete(opts)),
      } satisfies StreamClient;
    }),
    dependencies: [],
  },
) {}

/** Layer for StreamClient with all dependencies */
export const StreamClientLive: Layer.Layer<
  StreamClientService,
  never,
  HttpClient.HttpClient | DaemonService
> = Layer.effect(
  StreamClientService,
  Effect.gen(function* () {
    const daemon = yield* DaemonService;
    const httpClient = yield* HttpClient.HttpClient;

    const resolveServerUrl: Effect.Effect<string, ClientError> = Effect.gen(function* () {
      const envUrl = process.env.EVENT_STREAM_URL;
      if (envUrl) {
        return envUrl;
      }

      const daemonUrl = yield* daemon
        .getServerUrl()
        .pipe(Effect.catchAll(() => Effect.succeed(Option.none<string>())));
      if (Option.isSome(daemonUrl)) {
        return daemonUrl.value;
      }

      yield* Effect.log("No server found, starting daemon...");
      const pid = yield* daemon
        .start()
        .pipe(Effect.mapError((e) => new ClientError(`Failed to start daemon: ${e.message}`)));
      yield* Effect.log(`Daemon started (PID ${pid}), waiting for ready...`);

      const serverUrl = `http://localhost:${defaultDaemonConfig.port}`;

      yield* Effect.sleep("1 second");
      yield* Effect.log("Daemon ready");

      return serverUrl;
    });

    const withClient = <A, E>(
      fn: (client: StreamClient) => Effect.Effect<A, E>,
    ): Effect.Effect<A, E | ClientError> =>
      Effect.gen(function* () {
        const serverUrl = yield* resolveServerUrl;
        const client = yield* makeStreamClient({ serverUrl }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        );
        return yield* fn(client);
      });

    return {
      append: (opts: { name: StreamName; data: unknown }) => withClient((c) => c.append(opts)),
      subscribe: (opts: { name: StreamName; offset?: Offset }) =>
        withClient((c) => c.subscribe(opts)),
      subscribeAll: () => withClient((c) => c.subscribeAll()),
      get: (opts: { name: StreamName; offset?: Offset; limit?: number }) =>
        withClient((c) => c.get(opts)),
      list: () => withClient((c) => c.list()),
      delete: (opts: { name: StreamName }) => withClient((c) => c.delete(opts)),
    } as unknown as StreamClientService;
  }),
);
