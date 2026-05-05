/// <reference types="@cloudflare/workers-types" />

import {
  delegateToBaseFetch,
  type DurableObjectClass,
  type FetchBase,
  type RuntimeDurableObjectConstructor,
} from "./fetch-mixin-utils.ts";
import type { Constructor, MembersOf, ReqEnvOf, StaticSide } from "./mixin-types.ts";
import type {
  LifecycleHooksMembers,
  LifecycleHooksProtected,
  LifecycleInit,
} from "./with-lifecycle-hooks.ts";
import type { DurableObjectCoreProtected } from "./with-durable-object-core.ts";

const HIBERNATING_WEBSOCKET_ATTACHMENT_KEY = "__iterateHibernatingWebSocket";
const MAX_HIBERNATING_WEBSOCKET_TAGS = 10;
const MAX_HIBERNATING_WEBSOCKET_TAG_LENGTH = 256;

export type HibernatingWebSocketMessage = string | ArrayBuffer;

export type HibernatingWebSocketConnection<Attachment = unknown> = WebSocket & {
  readonly id: string;
  readonly tags: readonly string[];
  readonly originalUrl: string | null;
  /**
   * Read the small per-connection value stored with Cloudflare's WebSocket
   * attachment API.
   *
   * Cloudflare persists this value across hibernation and returns it from
   * `deserializeAttachment()` when the Durable Object wakes. Keep it small:
   * the serialized attachment limit is 2,048 bytes.
   *
   * https://developers.cloudflare.com/durable-objects/best-practices/websockets/#websocketdeserializeattachment
   */
  getHibernatingWebSocketAttachment(): Attachment | null;
  /**
   * Replace the Cloudflare WebSocket attachment and re-serialize it immediately.
   *
   * Mutating an object returned by `getHibernatingWebSocketAttachment()` is not
   * enough; Cloudflare only persists the value passed to
   * `serializeAttachment()`. This setter owns that write so callers do not
   * forget the hibernation persistence step.
   *
   * https://developers.cloudflare.com/durable-objects/best-practices/websockets/#websocketserializeattachment
   */
  setHibernatingWebSocketAttachment(attachment: Attachment | null): Attachment | null;
};

export type HibernatingWebSocketConnectionContext = {
  request: Request;
  url: URL;
};

export type HibernatingWebSocketBroadcastOptions = {
  tag?: string;
  except?: string | readonly string[];
};

type HibernatingWebSocketMetadata = {
  id: string;
  tags: string[];
  originalUrl: string | null;
};

type SerializedHibernatingWebSocketAttachment = {
  [HIBERNATING_WEBSOCKET_ATTACHMENT_KEY]: HibernatingWebSocketMetadata;
  attachment: unknown | null;
};

export abstract class HibernatingWebSocketsProtected {
  protected getHibernatingWebSocketTags(
    _connection: HibernatingWebSocketConnection,
    _context: HibernatingWebSocketConnectionContext,
  ): string[] | Promise<string[]> {
    throw new Error("HibernatingWebSocketsProtected is type-only and should never run.");
  }

  protected onHibernatingWebSocketConnect(
    _connection: HibernatingWebSocketConnection,
    _context: HibernatingWebSocketConnectionContext,
  ): void | Promise<void> {
    throw new Error("HibernatingWebSocketsProtected is type-only and should never run.");
  }

  protected onHibernatingWebSocketMessage(
    _connection: HibernatingWebSocketConnection,
    _message: HibernatingWebSocketMessage,
  ): void | Promise<void> {
    throw new Error("HibernatingWebSocketsProtected is type-only and should never run.");
  }

  protected onHibernatingWebSocketClose(
    _connection: HibernatingWebSocketConnection,
    _event: { code: number; reason: string; wasClean: boolean },
  ): void | Promise<void> {
    throw new Error("HibernatingWebSocketsProtected is type-only and should never run.");
  }

  protected onHibernatingWebSocketError(
    _connection: HibernatingWebSocketConnection,
    _error: unknown,
  ): void | Promise<void> {
    throw new Error("HibernatingWebSocketsProtected is type-only and should never run.");
  }

  protected getHibernatingWebSocket(_id: string): HibernatingWebSocketConnection | undefined {
    throw new Error("HibernatingWebSocketsProtected is type-only and should never run.");
  }

  protected getHibernatingWebSockets(_tag?: string): Iterable<HibernatingWebSocketConnection> {
    throw new Error("HibernatingWebSocketsProtected is type-only and should never run.");
  }

  protected broadcastHibernatingWebSocketMessage(
    _message: HibernatingWebSocketMessage,
    _options?: HibernatingWebSocketBroadcastOptions,
  ): void {
    throw new Error("HibernatingWebSocketsProtected is type-only and should never run.");
  }
}

type WithHibernatingWebSocketsResult<
  TBase extends DurableObjectClass,
  InitParams extends LifecycleInit,
> = StaticSide<TBase> &
  DurableObjectClass<
    ReqEnvOf<TBase>,
    MembersOf<TBase> &
      DurableObjectCoreProtected &
      LifecycleHooksMembers<InitParams> &
      LifecycleHooksProtected<InitParams> &
      HibernatingWebSocketsProtected &
      FetchBase
  > &
  Constructor<HibernatingWebSocketsProtected>;

type WebSocketLifecycleBase = {
  webSocketMessage?(ws: WebSocket, message: HibernatingWebSocketMessage): void | Promise<void>;
  webSocketClose?(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): void | Promise<void>;
  webSocketError?(ws: WebSocket, error: unknown): void | Promise<void>;
};

const attachmentCache = new WeakMap<WebSocket, SerializedHibernatingWebSocketAttachment>();

/**
 * Adds a fixed hibernatable WebSocket route to a Durable Object.
 *
 * This mixin owns `GET /__websocket` and delegates every other request to the
 * wrapped class's `fetch()`. That fixed route intentionally composes with
 * `withPublicFetchRoute()` without either mixin knowing about the other one:
 *
 *   /durable-objects/rooms/by-name/my-room/__websocket
 *
 * is stripped by the public route proxy to the DO-local `/__websocket`, which
 * this mixin handles.
 *
 * The mixin requires `withLifecycleHooks()` below it. A Durable Object can wake
 * from hibernation directly into `webSocketMessage`, `webSocketClose`, or
 * `webSocketError`, so every WebSocket entrypoint must restore lifecycle state
 * before app code runs. Making lifecycle required keeps that invariant visible
 * at the type boundary instead of relying on optional runtime detection.
 *
 * The implementation follows PartyServer's hibernation pattern, but stays as a
 * mixin instead of a root class: accept with `ctx.acceptWebSocket()`, store
 * connection metadata in Cloudflare's WebSocket attachment, reconstruct
 * connection objects lazily from `ctx.getWebSockets()`, and use tags for
 * post-hibernation lookup/filtering.
 *
 * `onHibernatingWebSocketConnect()` runs after the `101` response is created.
 * That is deliberate: view factories and auth/logging hooks are often async,
 * and sending frames from an async connect hook before the upgrade response
 * reaches the caller can drop those frames in workerd. Returning the accepted
 * socket first makes "send initial view after connect" behave like a normal
 * post-handshake server send. We still pass the promise through the core
 * `ctx.waitUntil()` adapter for symmetry with other runtime capabilities, but
 * Cloudflare documents that `waitUntil()` has no effect in Durable Objects
 * because pending work already keeps the object active:
 * https://developers.cloudflare.com/durable-objects/api/state/#waituntil
 *
 * First-party Cloudflare docs behind the design:
 *
 * - Hibernation keeps clients connected while in-memory state is reset, and the
 *   constructor runs again when a message wakes the object:
 *   https://developers.cloudflare.com/durable-objects/best-practices/websockets/#how-hibernation-works
 * - `DurableObjectState.acceptWebSocket()` is the hibernation API; `ws.accept()`
 *   and `addEventListener()` are the standard API and should not be mixed with
 *   it:
 *   https://developers.cloudflare.com/durable-objects/api/state/#acceptwebsocket
 * - `serializeAttachment()` / `deserializeAttachment()` are Cloudflare's
 *   per-connection persistence primitive across hibernation, with a 2,048 byte
 *   serialized limit:
 *   https://developers.cloudflare.com/durable-objects/best-practices/websockets/#websocketserializeattachment
 */
export function withHibernatingWebSockets<InitParams extends LifecycleInit>() {
  return function <TBase extends DurableObjectClass>(
    Base: TBase &
      Constructor<
        DurableObjectCoreProtected &
          LifecycleHooksMembers<InitParams> &
          LifecycleHooksProtected<InitParams>
      >,
  ): WithHibernatingWebSocketsResult<TBase, InitParams> {
    const BaseWithLifecycle = Base as unknown as RuntimeDurableObjectConstructor &
      Constructor<
        DurableObjectCoreProtected &
          LifecycleHooksMembers<InitParams> &
          LifecycleHooksProtected<InitParams>
      >;

    abstract class HibernatingWebSocketsMixin extends BaseWithLifecycle {
      async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname !== "/__websocket") {
          return await delegateToBaseFetch(Base, this, request);
        }

        if (request.method !== "GET") {
          return Response.json({ error: "Method not allowed" }, { status: 405 });
        }

        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
          return Response.json({ error: "Expected WebSocket upgrade." }, { status: 400 });
        }

        await this.ensureStarted();

        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        const connectionId = readConnectionId(url);
        const serializedAttachment: SerializedHibernatingWebSocketAttachment = {
          [HIBERNATING_WEBSOCKET_ATTACHMENT_KEY]: {
            id: connectionId,
            // The id is always a tag. Cloudflare lets `getWebSockets(tag)`
            // filter sockets by tags supplied to `acceptWebSocket()`, and the
            // same docs cap those tags at 10 per socket / 256 chars each:
            // https://developers.cloudflare.com/durable-objects/api/state/#acceptwebsocket
            // Making the id a tag lets `getHibernatingWebSocket(id)` find a
            // single connection after hibernation, when all in-memory maps are
            // gone.
            tags: [connectionId],
            originalUrl: request.url,
          },
          attachment: null,
        };
        const connection = createHibernatingWebSocketConnection(server, serializedAttachment);
        const context = { request, url };
        const tags = prepareHibernatingWebSocketTags(
          connectionId,
          await this.getHibernatingWebSocketTags(connection, context),
        );

        serializedAttachment[HIBERNATING_WEBSOCKET_ATTACHMENT_KEY].tags = tags;

        // This is the hibernation-critical accept call. Cloudflare documents
        // `ctx.acceptWebSocket()` as the API that allows the Durable Object to
        // be removed from memory while the WebSocket remains connected; the
        // standard `server.accept()` path does not provide that hibernation
        // behavior.
        // https://developers.cloudflare.com/durable-objects/best-practices/websockets/#durable-objects-hibernation-websocket-api
        this.acceptDurableObjectWebSocket(server, tags);

        // Cloudflare calls this persisted per-WebSocket value an "attachment".
        // Keep our public method names aligned with that term. The attachment
        // is not Durable Object state, React state, or app model state; it is
        // the small serializable value recovered from a raw WebSocket after
        // hibernation by `deserializeAttachment()`. Cloudflare caps the
        // serialized attachment at 2,048 bytes, so application data larger than
        // "small connection metadata" belongs in DO storage with only its key
        // stored here.
        // https://developers.cloudflare.com/durable-objects/best-practices/websockets/#websocketserializeattachment
        writeSerializedAttachment(server, serializedAttachment);

        const response = new Response(null, { status: 101, webSocket: client });
        this.waitUntilDurableObjectTask(
          runAfterWebSocketUpgradeResponse(async () => {
            try {
              await this.onHibernatingWebSocketConnect(connection, context);
            } catch (error) {
              connection.close(1011, "Unexpected error during WebSocket connect");
              throw error;
            }
          }),
        );

        return response;
      }

      async webSocketMessage(ws: WebSocket, message: HibernatingWebSocketMessage): Promise<void> {
        const connection = tryCreateHibernatingWebSocketConnection(ws);
        if (connection === null) {
          await delegateWebSocketMessage(Base, this, ws, message);
          return;
        }

        await this.ensureStarted();
        await this.onHibernatingWebSocketMessage(connection, message);
      }

      async webSocketClose(
        ws: WebSocket,
        code: number,
        reason: string,
        wasClean: boolean,
      ): Promise<void> {
        const connection = tryCreateHibernatingWebSocketConnection(ws);
        if (connection === null) {
          await delegateWebSocketClose(Base, this, ws, code, reason, wasClean);
          return;
        }

        await this.ensureStarted();
        await this.onHibernatingWebSocketClose(connection, { code, reason, wasClean });
      }

      async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
        const connection = tryCreateHibernatingWebSocketConnection(ws);
        if (connection === null) {
          await delegateWebSocketError(Base, this, ws, error);
          return;
        }

        await this.ensureStarted();
        await this.onHibernatingWebSocketError(connection, error);
      }

      protected getHibernatingWebSocketTags(
        _connection: HibernatingWebSocketConnection,
        _context: HibernatingWebSocketConnectionContext,
      ): string[] | Promise<string[]> {
        return [];
      }

      protected onHibernatingWebSocketConnect(
        _connection: HibernatingWebSocketConnection,
        _context: HibernatingWebSocketConnectionContext,
      ): void | Promise<void> {}

      protected onHibernatingWebSocketMessage(
        _connection: HibernatingWebSocketConnection,
        _message: HibernatingWebSocketMessage,
      ): void | Promise<void> {}

      protected onHibernatingWebSocketClose(
        _connection: HibernatingWebSocketConnection,
        _event: { code: number; reason: string; wasClean: boolean },
      ): void | Promise<void> {}

      protected onHibernatingWebSocketError(
        _connection: HibernatingWebSocketConnection,
        _error: unknown,
      ): void | Promise<void> {}

      protected getHibernatingWebSocket(id: string): HibernatingWebSocketConnection | undefined {
        const matches = this.getDurableObjectWebSockets(id)
          .map((ws) => tryCreateHibernatingWebSocketConnection(ws))
          .filter((connection): connection is HibernatingWebSocketConnection => {
            return connection !== null && connection.id === id && isOpenWebSocket(connection);
          });

        if (matches.length > 1) {
          throw new Error(`More than one hibernating WebSocket connection found for id "${id}".`);
        }

        return matches[0];
      }

      protected *getHibernatingWebSockets(tag?: string): Iterable<HibernatingWebSocketConnection> {
        for (const ws of this.getDurableObjectWebSockets(tag)) {
          const connection = tryCreateHibernatingWebSocketConnection(ws);
          if (connection !== null && isOpenWebSocket(connection)) {
            yield connection;
          }
        }
      }

      protected broadcastHibernatingWebSocketMessage(
        message: HibernatingWebSocketMessage,
        options?: HibernatingWebSocketBroadcastOptions,
      ): void {
        const excludedIds = new Set(
          typeof options?.except === "string" ? [options.except] : (options?.except ?? []),
        );

        for (const connection of this.getHibernatingWebSockets(options?.tag)) {
          if (excludedIds.has(connection.id)) continue;

          try {
            connection.send(message);
          } catch {
            connection.close(1011, "Unexpected send failure");
          }
        }
      }
    }

    return HibernatingWebSocketsMixin as unknown as WithHibernatingWebSocketsResult<
      TBase,
      InitParams
    >;
  };
}

function readConnectionId(url: URL): string {
  return url.searchParams.get("_pk") ?? url.searchParams.get("connectionId") ?? crypto.randomUUID();
}

function prepareHibernatingWebSocketTags(connectionId: string, userTags: string[]): string[] {
  const tags = [connectionId, ...userTags.filter((tag) => tag !== connectionId)];
  const deduped = Array.from(new Set(tags));

  if (deduped.length > MAX_HIBERNATING_WEBSOCKET_TAGS) {
    throw new Error(
      `A hibernating WebSocket connection can only have ${MAX_HIBERNATING_WEBSOCKET_TAGS.toString()} tags including the connection id tag.`,
    );
  }

  for (const tag of deduped) {
    if (typeof tag !== "string") {
      throw new Error("Hibernating WebSocket tags must be strings.");
    }

    if (tag.length === 0) {
      throw new Error("Hibernating WebSocket tags must not be empty.");
    }

    if (tag.length > MAX_HIBERNATING_WEBSOCKET_TAG_LENGTH) {
      throw new Error(
        `Hibernating WebSocket tags must not exceed ${MAX_HIBERNATING_WEBSOCKET_TAG_LENGTH.toString()} characters.`,
      );
    }
  }

  return deduped;
}

function tryCreateHibernatingWebSocketConnection(
  ws: WebSocket,
): HibernatingWebSocketConnection | null {
  const serializedAttachment = readSerializedAttachment(ws);
  if (serializedAttachment === null) return null;

  return createHibernatingWebSocketConnection(ws, serializedAttachment);
}

function createHibernatingWebSocketConnection(
  ws: WebSocket,
  serializedAttachment: SerializedHibernatingWebSocketAttachment,
): HibernatingWebSocketConnection {
  attachmentCache.set(ws, serializedAttachment);

  if ("getHibernatingWebSocketAttachment" in ws) {
    return ws as HibernatingWebSocketConnection;
  }

  return Object.defineProperties(ws, {
    id: {
      configurable: true,
      get() {
        return getCachedSerializedAttachment(ws)[HIBERNATING_WEBSOCKET_ATTACHMENT_KEY].id;
      },
    },
    tags: {
      configurable: true,
      get() {
        return getCachedSerializedAttachment(ws)[HIBERNATING_WEBSOCKET_ATTACHMENT_KEY].tags;
      },
    },
    originalUrl: {
      configurable: true,
      get() {
        return getCachedSerializedAttachment(ws)[HIBERNATING_WEBSOCKET_ATTACHMENT_KEY].originalUrl;
      },
    },
    getHibernatingWebSocketAttachment: {
      configurable: true,
      value() {
        return getCachedSerializedAttachment(ws).attachment;
      },
    },
    setHibernatingWebSocketAttachment: {
      configurable: true,
      value(attachment: unknown | null) {
        const next = {
          ...getCachedSerializedAttachment(ws),
          attachment,
        };
        writeSerializedAttachment(ws, next);
        return attachment;
      },
    },
  }) as HibernatingWebSocketConnection;
}

function getCachedSerializedAttachment(ws: WebSocket): SerializedHibernatingWebSocketAttachment {
  const cached = attachmentCache.get(ws);
  if (cached !== undefined) return cached;

  const serializedAttachment = readSerializedAttachment(ws);
  if (serializedAttachment === null) {
    throw new Error("Missing hibernating WebSocket attachment.");
  }

  attachmentCache.set(ws, serializedAttachment);
  return serializedAttachment;
}

function readSerializedAttachment(ws: WebSocket): SerializedHibernatingWebSocketAttachment | null {
  const raw = deserializeNativeWebSocketAttachment(ws);
  if (!isRecord(raw)) return null;

  const metadata = raw[HIBERNATING_WEBSOCKET_ATTACHMENT_KEY];
  if (!isRecord(metadata)) return null;
  if (typeof metadata.id !== "string") return null;
  if (!Array.isArray(metadata.tags) || !metadata.tags.every((tag) => typeof tag === "string")) {
    return null;
  }
  if (typeof metadata.originalUrl !== "string" && metadata.originalUrl !== null) return null;

  return {
    [HIBERNATING_WEBSOCKET_ATTACHMENT_KEY]: {
      id: metadata.id,
      tags: metadata.tags,
      originalUrl: metadata.originalUrl,
    },
    attachment: raw.attachment ?? null,
  };
}

function writeSerializedAttachment(
  ws: WebSocket,
  serializedAttachment: SerializedHibernatingWebSocketAttachment,
): void {
  attachmentCache.set(ws, serializedAttachment);
  serializeNativeWebSocketAttachment(ws, serializedAttachment);
}

function deserializeNativeWebSocketAttachment(ws: WebSocket): unknown {
  try {
    return WebSocket.prototype.deserializeAttachment.call(ws);
  } catch {
    return null;
  }
}

function serializeNativeWebSocketAttachment(
  ws: WebSocket,
  serializedAttachment: SerializedHibernatingWebSocketAttachment,
): void {
  WebSocket.prototype.serializeAttachment.call(ws, serializedAttachment);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOpenWebSocket(ws: WebSocket): boolean {
  return ws.readyState === WebSocket.OPEN;
}

async function delegateWebSocketMessage(
  Base: DurableObjectClass,
  instance: object,
  ws: WebSocket,
  message: HibernatingWebSocketMessage,
): Promise<void> {
  const baseMethod = (Base.prototype as WebSocketLifecycleBase).webSocketMessage;
  if (baseMethod !== undefined) await baseMethod.call(instance, ws, message);
}

async function delegateWebSocketClose(
  Base: DurableObjectClass,
  instance: object,
  ws: WebSocket,
  code: number,
  reason: string,
  wasClean: boolean,
): Promise<void> {
  const baseMethod = (Base.prototype as WebSocketLifecycleBase).webSocketClose;
  if (baseMethod !== undefined) await baseMethod.call(instance, ws, code, reason, wasClean);
}

async function delegateWebSocketError(
  Base: DurableObjectClass,
  instance: object,
  ws: WebSocket,
  error: unknown,
): Promise<void> {
  const baseMethod = (Base.prototype as WebSocketLifecycleBase).webSocketError;
  if (baseMethod !== undefined) await baseMethod.call(instance, ws, error);
}

function runAfterWebSocketUpgradeResponse(callback: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    // A zero-delay timer deliberately moves connect-hook work out of the fetch
    // call stack that creates the 101 response. Workerd can otherwise deliver
    // async hook sends before the caller-side `response.webSocket.accept()`,
    // which loses initial view messages in tests and mirrors a real handshake
    // ordering hazard. Durable Objects remain active while there is pending
    // work, so the timer-owned callback is still part of this wake even though
    // Cloudflare documents `ctx.waitUntil()` as a no-op in Durable Objects.
    setTimeout(() => {
      callback().then(resolve, reject);
    }, 0);
  });
}
