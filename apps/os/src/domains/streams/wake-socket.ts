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
// cursor and filter, and the next matching append sends one
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
// The transport mechanics are shared with capability-host provider leases in
// hibernatable-rpc-lease.ts. Delete the stream adapter and relay when native
// hibernatable RPC ships: the retained callback then survives hibernation on
// its own and the wake socket is redundant.

import { z } from "zod";
import type { StreamEvent } from "iterate/processors";
import { HibernatableRpcLeaseSockets } from "../hibernatable-rpc-lease.ts";
import { compileEventFilter, EventFilter } from "./event-filter.ts";

/** Internal upgrade header carrying the wake-socket binding; never routed from external requests. */
export const STREAM_WAKE_SOCKET_HEADER = "x-iterate-stream-wake";

/** The hibernation tag every wake socket is accepted under. */
const WAKE_SOCKET_TAG = "wake";

/** The JSON body of {@link STREAM_WAKE_SOCKET_HEADER} on the upgrade request. */
const WakeSocketUpgradeHeader = z
  .object({
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
  })
  .transform(({ connectionKey, socketId }) => ({ leaseKey: connectionKey, socketId }));

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
  readonly #leases: HibernatableRpcLeaseSockets<WakeSocketAttachment>;

  constructor(hooks: WakeSocketRegistryHooks) {
    this.#hooks = hooks;
    this.#leases = new HibernatableRpcLeaseSockets({
      attachmentSchema: WakeSocketAttachment,
      bindingOf: (attachment) => ({
        leaseKey: attachment.connectionKey,
        socketId: attachment.socketId,
      }),
      createAttachment: ({ leaseKey, socketId }) => ({
        v: 1,
        connectionKey: leaseKey,
        socketId,
      }),
      headerName: STREAM_WAKE_SOCKET_HEADER,
      hooks,
      lane: "stream wake",
      socketTag: WAKE_SOCKET_TAG,
      upgradeSchema: WakeSocketUpgradeHeader,
    });
  }

  /**
   * The wake-socket upgrade, dialed by the relay through the DO's stub (a
   * 101 response cannot cross an RPC method call, so this rides a real
   * `fetch()`). Unreachable from external requests — no ingress lane routes
   * fetches to Stream DOs — and additionally gated on the internal header.
   */
  acceptUpgrade(request: Request): Response {
    return this.#leases.acceptUpgrade(request);
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
    const attachment = this.#leases.attachment(ws);
    if (attachment === undefined || attachment.idleDeliveredThrough === undefined) {
      return undefined;
    }
    if (this.#hooks.hasConnection(attachment.connectionKey)) return undefined;
    return { connectionKey: attachment.connectionKey, socketId: attachment.socketId };
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
    const claimed = this.#leases.claim({
      leaseKey: args.connectionKey,
      socketId: args.wakeSocketId ?? "missing-wake-socket-id",
    });
    if (claimed !== undefined) {
      this.#leases.stamp(claimed.ws, {
        v: 1,
        connectionKey: args.connectionKey,
        socketId: claimed.attachment.socketId,
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
      this.#leases.stamp(ws, { ...rest, idleDeliveredThrough: maxOffset });
      // Closing the RPC leg released the retained callback, but the relay
      // still holds its StreamConnectionHandle stub — a live reference into
      // this isolate that blocks hibernation on its own. The idle frame tells
      // the relay to dispose it; best-effort, since a broken socket already
      // means the relay's execution context (and with it the stub) is gone.
      this.#leases.send(ws, { type: "idle" });
    }
  }

  /**
   * Offer just-committed events to dormant subscribers. The caller (the
   * sender's post-commit send check) is necessarily running inside an awake
   * DO, so no alarm is needed. At most one wake frame per dormancy period
   * (`wakeSentAtOffset`; cleared when the relay's re-dial re-binds the key),
   * while the stream's own lifecycle facts remain excluded — waking on those
   * is the resurrection loop documented on {@link WAKE_EXCLUDED_EVENT_TYPES}.
   * Ephemeral events do wake a matching subscriber as a best-effort latency
   * hint: the append itself places the event in this incarnation's memory and
   * a prompt re-dial can replay it from the subscriber's exact cursor. If the
   * incarnation ends first, the event is intentionally gone.
   */
  wakeDormant(justCommitted: readonly StreamEvent[]): void {
    const news = justCommitted;
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
        this.#leases.close(ws, 1011, "filter compile failed");
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
      if (!this.#leases.send(ws, { type: "wake" })) continue;
      this.#leases.stamp(ws, {
        ...attachment,
        wakeSentAtOffset: this.#hooks.maxOffset(),
      });
    }
  }

  /** Live wake sockets with a valid attachment, optionally for one connectionKey. */
  #sockets(connectionKey?: string): { ws: WebSocket; attachment: WakeSocketAttachment }[] {
    return this.#leases.entries(connectionKey).map(({ attachment, ws }) => ({
      attachment,
      ws,
    }));
  }
}
