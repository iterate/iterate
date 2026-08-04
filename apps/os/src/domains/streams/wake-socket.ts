// The wake-socket protocol between the fronting Worker's stream-connection
// relay (stream-connection-relay.ts) and the Stream Durable Object.
//
// A session connection's retained processEventBatch callback is a live RPC
// capability into the Stream DO's isolate, so every open session connection
// pins the DO in memory and bills wall-clock duration for its whole life
// (Workers RPC has no hibernation — workerd #6087 tracks it). The relay
// therefore opens a SECOND, parallel channel: a WebSocket dialed via the DO
// stub's real `fetch()` (a 101 cannot cross an RPC method call) and accepted
// with `ctx.acceptWebSocket`, which costs nothing while the DO hibernates.
// Once a session connection has a wake socket, the stream's idle teardown may
// sever the RPC leg; the socket's attachment remembers the delivered-through
// cursor and filter, and the next matching non-ephemeral append sends one
// `{"type":"wake"}` frame so the relay re-dials
// `openConnection({ replayAfterOffset })`. The client's Cap'n Web session
// never observes any of this.
//
// Two frame types cross the socket, both DO → relay, both fire-and-forget
// JSON: `{"type":"idle"}` when idle teardown severed the RPC leg — the relay
// must dispose its StreamConnectionHandle stub, whose reference into the DO's
// isolate would otherwise keep blocking hibernation all by itself — and
// `{"type":"wake"}` when a matching append lands while dormant. Catch-up
// correctness never depends on a frame arriving: the re-dial replays from the
// relay's delivered cursor.
//
// Delete this module (and stream-connection-relay.ts) when hibernatable RPC
// ships: the retained callback then survives hibernation on its own and the
// wake socket is redundant.

import { z } from "zod";
import type { StreamEvent } from "iterate/processors";
import { compileEventFilter, EventFilter } from "./event-filter.ts";

/** Internal upgrade header carrying the wake-socket binding; never routed from external requests. */
export const STREAM_WAKE_SOCKET_HEADER = "x-iterate-stream-wake";

/** The hibernation tag every wake socket is accepted under. */
const WAKE_SOCKET_TAG = "wake";

/** The JSON body of {@link STREAM_WAKE_SOCKET_HEADER} on the upgrade request. */
const WakeSocketUpgradeHeader = z.object({
  connectionKey: z.string().trim().min(1),
  /**
   * Relay-generated unique id for this exact socket. `bind` keeps the socket
   * whose id its relay dialed with and closes every other socket under the
   * same connectionKey: a same-key replacement must leave the losing relay's
   * socket closed (its relay then breaks, matching today's last-writer-wins
   * handle death) instead of dormant — a dormant loser would wake on every
   * append and fight the winner with alternating re-dials forever.
   */
  socketId: z.string().trim().min(1),
});

/**
 * The durable per-socket state, stored via `serializeAttachment` so it
 * survives Stream DO hibernation and eviction. `idleDeliveredThrough` present
 * means the RPC leg was idle-closed and the subscriber is dormant;
 * `wakeSentAtOffset` present means one wake frame was already sent for this
 * dormancy period (cleared when the relay's re-dial re-binds the key).
 */
const WakeSocketAttachment = z.object({
  v: z.literal(1),
  connectionKey: z.string().min(1),
  socketId: z.string().min(1),
  /** The connection's raw filter spec, re-checked before waking. */
  filter: EventFilter.optional(),
  /** `false` mirrors a state-only connection (`openConnection({ events: false })`). */
  events: z.literal(false).optional(),
  idleDeliveredThrough: z.number().int().nonnegative().optional(),
  wakeSentAtOffset: z.number().int().nonnegative().optional(),
});

type WakeSocketAttachment = z.infer<typeof WakeSocketAttachment>;

/**
 * A frame sent DO → relay on the wake socket. Loose objects on purpose: a
 * newer DO may add fields the relay's deploy does not know yet, and the relay
 * must keep honoring the `type` it does understand. A frame whose `type` is
 * unknown fails the whole union and is dropped whole — that is the intended
 * posture for future frame kinds too.
 */
const WakeSocketFrame = z.union([
  z.object({ type: z.literal("wake") }),
  z.object({ type: z.literal("idle") }),
]);

type WakeSocketFrame = z.infer<typeof WakeSocketFrame>;

/** Decode one inbound wake-socket frame; anything unparseable is dropped whole. */
export function parseWakeSocketFrame(data: unknown): WakeSocketFrame | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const parsed = WakeSocketFrame.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stream lifecycle bookkeeping never wakes a dormant subscriber. The idle
 * close itself appends `connection-closed`, every cold boot appends `woken`,
 * and a wake re-dial appends `connection-opened` — waking on any of those
 * would turn each idle close or DO boot into a resurrection of every dormant
 * subscriber (the `close → wake → open → idle-close` loop the hosted idle
 * teardown already defends against, see `runIdleTeardownNow`). A subscriber
 * whose filter explicitly names one of these types still receives it: the
 * exclusion only defers delivery to the next matching wake, where the re-dial
 * replays everything after the relay's cursor.
 */
const WAKE_EXCLUDED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "events.iterate.com/stream/woken",
  "events.iterate.com/stream/connection-opened",
  "events.iterate.com/stream/connection-closed",
]);

/** The seams {@link WakeSocketRegistry} needs from its hosting Durable Object. */
type WakeSocketRegistryHooks = {
  /** `ctx.getWebSockets` scoped by tag. */
  getWebSockets(tag: string): WebSocket[];
  /** `ctx.acceptWebSocket` (hibernation API). */
  acceptWebSocket(ws: WebSocket, tags: string[]): void;
  /** Current committed max offset, read at call time (never captured). */
  maxOffset(): number;
  /** Whether a live connection currently exists for this key. */
  hasConnection(connectionKey: string): boolean;
};

/**
 * All Durable-Object-side wake-socket mechanics: accepting upgrades, binding
 * sockets to connections, stamping dormancy, and waking dormant subscribers.
 * The hosting DO delegates its `fetch` upgrade and two sender hooks here; the
 * attachment is the whole durable state, so the registry itself is stateless
 * and survives eviction for free.
 */
export class WakeSocketRegistry {
  readonly #hooks: WakeSocketRegistryHooks;

  constructor(hooks: WakeSocketRegistryHooks) {
    this.#hooks = hooks;
  }

  /**
   * The wake-socket upgrade, dialed by the relay through the DO's stub (a
   * 101 response cannot cross an RPC method call, so this rides a real
   * `fetch()`). Unreachable from external requests — no ingress lane routes
   * fetches to Stream DOs — and additionally gated on the internal header.
   */
  acceptUpgrade(request: Request): Response {
    const wakeHeader = request.headers.get(STREAM_WAKE_SOCKET_HEADER);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket" || wakeHeader === null) {
      return Response.json(
        { error: "stream durable objects accept only wake-socket upgrades" },
        { status: 400 },
      );
    }
    let parsedHeader: unknown;
    try {
      parsedHeader = JSON.parse(wakeHeader);
    } catch (error) {
      return Response.json(
        {
          error: `invalid ${STREAM_WAKE_SOCKET_HEADER} header: ${error instanceof Error ? error.message : String(error)}`,
        },
        { status: 400 },
      );
    }

    const binding = WakeSocketUpgradeHeader.safeParse(parsedHeader);
    if (!binding.success) {
      return Response.json(
        { error: `invalid ${STREAM_WAKE_SOCKET_HEADER} header: ${binding.error.message}` },
        { status: 400 },
      );
    }
    const pair = new WebSocketPair();
    this.#hooks.acceptWebSocket(pair[1], [WAKE_SOCKET_TAG]);
    pair[1].serializeAttachment({
      v: 1,
      connectionKey: binding.data.connectionKey,
      socketId: binding.data.socketId,
    } satisfies WakeSocketAttachment);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /**
   * Dormant subscribers — idle-closed connections whose subscriber is still
   * present on a wake socket — for the stream's runtime debug state, so
   * presence surfaces can show them instead of rendering an idle tab as gone.
   */
  dormantRuntimeState(): Record<
    string,
    { idleDeliveredThrough: number; wakeSentAtOffset?: number }
  > {
    const dormant: Record<string, { idleDeliveredThrough: number; wakeSentAtOffset?: number }> = {};
    for (const { attachment } of this.#sockets()) {
      if (attachment.idleDeliveredThrough === undefined) continue;
      if (this.#hooks.hasConnection(attachment.connectionKey)) continue;
      dormant[attachment.connectionKey] = {
        idleDeliveredThrough: attachment.idleDeliveredThrough,
        ...(attachment.wakeSentAtOffset === undefined
          ? {}
          : { wakeSentAtOffset: attachment.wakeSentAtOffset }),
      };
    }
    return dormant;
  }

  /**
   * Called from the DO's `webSocketClose`: if this socket carried a DORMANT
   * subscriber (idle-closed connection, no live replacement), its closing IS
   * the subscriber's real departure and deserves a durable close fact — the
   * earlier `"idle"` close deliberately was not one. Live connections are
   * excluded: their own close paths append their reasons. Returns the
   * departed connectionKey and this socket's id (for an idempotency key), or
   * undefined when no fact is owed.
   */
  departedOnClose(ws: WebSocket): { connectionKey: string; socketId: string } | undefined {
    let raw: unknown;
    try {
      raw = ws.deserializeAttachment();
    } catch {
      return undefined;
    }
    const parsed = WakeSocketAttachment.safeParse(raw);
    if (!parsed.success) return undefined;
    if (parsed.data.idleDeliveredThrough === undefined) return undefined;
    if (this.#hooks.hasConnection(parsed.data.connectionKey)) return undefined;
    return { connectionKey: parsed.data.connectionKey, socketId: parsed.data.socketId };
  }

  /** connectionKeys that currently have a live wake socket — one scan per call. */
  channelKeys(): ReadonlySet<string> {
    return new Set(this.#sockets().map(({ attachment }) => attachment.connectionKey));
  }

  /**
   * Bind this connection's own wake socket (dialed by its relay just before
   * the openConnection call, or surviving a DO eviction): store the raw
   * filter spec so a dormant-period append can be matched without a live
   * connection, and clear any dormancy state from an earlier idle close.
   * Every OTHER socket under this connectionKey belongs to a replaced relay —
   * close it so that relay breaks (see {@link WakeSocketUpgradeHeader}).
   */
  bind(args: {
    connectionKey: string;
    wakeSocketId: string | undefined;
    filter: EventFilter;
    events?: boolean;
  }): void {
    const hasFilter = Object.values(args.filter).some((value) => value !== undefined);
    for (const { ws, attachment } of this.#sockets(args.connectionKey)) {
      if (attachment.socketId !== args.wakeSocketId) {
        try {
          ws.close(1000, "superseded");
        } catch {
          // Already closing.
        }
        continue;
      }
      this.#stamp(ws, {
        v: 1,
        connectionKey: args.connectionKey,
        socketId: attachment.socketId,
        ...(hasFilter ? { filter: args.filter } : {}),
        ...(args.events === false ? { events: false as const } : {}),
      });
    }
  }

  /**
   * Idle teardown just closed these session connections; make this teardown's
   * own close facts unable to wake the subscribers they closed, and tell each
   * relay to drop its handle stub. Called AFTER the close-fact appends so the
   * stamped cursor covers their offsets, mirroring the hosted-cursor ack.
   */
  recordIdleClosed(connectionKeys: readonly string[]): void {
    const maxOffset = this.#hooks.maxOffset();
    const idled = new Set(connectionKeys);
    for (const { ws, attachment } of this.#sockets()) {
      if (!idled.has(attachment.connectionKey)) continue;
      const { wakeSentAtOffset: _cleared, ...rest } = attachment;
      this.#stamp(ws, { ...rest, idleDeliveredThrough: maxOffset });
      // Closing the RPC leg released the retained callback, but the relay
      // still holds its StreamConnectionHandle stub — a live reference into
      // this isolate that blocks hibernation on its own. The idle frame tells
      // the relay to dispose it; best-effort, since a broken socket already
      // means the relay's execution context (and with it the stub) is gone.
      try {
        ws.send(JSON.stringify({ type: "idle" } satisfies WakeSocketFrame));
      } catch (error) {
        console.warn("stream idle frame send failed", {
          connectionKey: attachment.connectionKey,
          error,
        });
      }
    }
  }

  /**
   * Offer just-committed events to dormant subscribers. The caller (the
   * sender's post-commit send check) is necessarily running inside an awake
   * DO, so no alarm is needed. At most one wake frame per dormancy period
   * (`wakeSentAtOffset`; cleared when the relay's re-dial re-binds the key),
   * and never for ephemeral rows or the stream's own lifecycle facts — a
   * re-dialed connection cannot replay ephemeral history, and waking on
   * lifecycle facts is the resurrection loop documented on
   * {@link WAKE_EXCLUDED_EVENT_TYPES}.
   */
  wakeDormant(justCommitted: readonly StreamEvent[]): void {
    const news = justCommitted.filter((event) => event.ephemeral !== true);
    if (news.length === 0) return;
    const sockets = this.#sockets();
    if (sockets.length === 0) return;

    for (const { ws, attachment } of sockets) {
      if (attachment.wakeSentAtOffset !== undefined) continue;
      if (this.#hooks.hasConnection(attachment.connectionKey)) continue;
      // A stamped attachment is ordinary dormancy (idle teardown). An
      // UNSTAMPED socket whose connection is absent means the RPC leg died
      // without the idle protocol — DO eviction mid-live, a delivery-failure
      // close — so its cursor is unknown: any qualifying news wakes it, and
      // the relay re-dials from its own exact cursor. That makes the wake
      // path double as eviction recovery for session subscribers.
      const idleDeliveredThrough = attachment.idleDeliveredThrough;
      const explicitTypes = attachment.filter?.eventTypes;
      let matcher: ReturnType<typeof compileEventFilter> | undefined;
      try {
        matcher =
          attachment.filter === undefined ? undefined : compileEventFilter(attachment.filter);
      } catch (error) {
        // A stored spec that compiled at bind time can stop compiling under a
        // later deploy; throwing out of the post-commit send check would put
        // every append into repair backoff with the socket never culled.
        // Same degrade as a failed stamp: drop the socket, connection pins.
        console.warn("wake socket filter no longer compiles; closing socket", {
          connectionKey: attachment.connectionKey,
          error,
        });
        try {
          ws.close(1011, "filter compile failed");
        } catch {
          // Already closing.
        }
        continue;
      }
      const matched = news.some((event) => {
        if (idleDeliveredThrough !== undefined && event.offset <= idleDeliveredThrough) {
          return false;
        }
        // Lifecycle facts wake only a subscriber whose filter names them.
        if (
          WAKE_EXCLUDED_EVENT_TYPES.has(event.type) &&
          explicitTypes?.includes(event.type) !== true
        ) {
          return false;
        }
        // A state-only connection wants any state change; a filterless one wants everything.
        if (attachment.events === false || matcher === undefined) return true;
        try {
          return matcher.matches(event);
        } catch {
          // A condition that throws at match time is the delivery side's
          // policy decision; wake the subscriber and let delivery decide.
          return true;
        }
      });
      if (!matched) continue;
      try {
        ws.send(JSON.stringify({ type: "wake" } satisfies WakeSocketFrame));
      } catch (error) {
        console.warn("stream wake frame send failed", {
          connectionKey: attachment.connectionKey,
          error,
        });
        continue;
      }
      this.#stamp(ws, { ...attachment, wakeSentAtOffset: this.#hooks.maxOffset() });
    }
  }

  /** Live wake sockets with a valid attachment, optionally for one connectionKey. */
  #sockets(connectionKey?: string): { ws: WebSocket; attachment: WakeSocketAttachment }[] {
    const sockets: { ws: WebSocket; attachment: WakeSocketAttachment }[] = [];
    for (const ws of this.#hooks.getWebSockets(WAKE_SOCKET_TAG)) {
      let raw: unknown;
      try {
        raw = ws.deserializeAttachment();
      } catch {
        continue;
      }
      const parsed = WakeSocketAttachment.safeParse(raw);
      if (!parsed.success) continue;
      if (connectionKey !== undefined && parsed.data.connectionKey !== connectionKey) continue;
      sockets.push({ ws, attachment: parsed.data });
    }
    return sockets;
  }

  /**
   * The one attachment writer. `serializeAttachment` has a hard size cap
   * (16 KiB serialized) and the filter spec is caller-controlled, so a stamp
   * can fail on a pathologically large filter. Never let that break the
   * caller (an openConnection or a post-commit turn): close the socket
   * instead — the connection then simply keeps today's pinned session
   * semantics, and the relay degrades exactly as if the upgrade had failed.
   */
  #stamp(ws: WebSocket, attachment: WakeSocketAttachment): void {
    try {
      ws.serializeAttachment(attachment);
    } catch (error) {
      console.warn(
        "wake socket attachment stamp failed; closing socket (connection stays pinned)",
        {
          connectionKey: attachment.connectionKey,
          error,
        },
      );
      try {
        ws.close(1011, "attachment stamp failed");
      } catch {
        // Already closing.
      }
    }
  }
}
