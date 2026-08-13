// The Stream Subscriber Pager between the fronting Worker's connection relay
// (stream-connection-relay.ts) and one Stream Durable Object.
//
// A session connection's retained processEventBatch callback is a live RPC
// capability into the Stream DO's isolate, so every open session connection
// pins the DO in memory and bills wall-clock duration for its whole life
// (Workers RPC has no hibernation — workerd #6087 tracks it). The relay
// therefore gives the DO a SECOND, parallel channel: a client-supplied
// WebSocket dialed via the DO stub's real `fetch()` (a 101 cannot cross an RPC
// method call) and accepted with `ctx.acceptWebSocket`, which costs nothing
// while the DO hibernates. That channel is the Pager: "you may release my RPC
// leg; Page me here when new work needs me." Its attachment remembers the
// delivered-through cursor and filter. The next matching append sends one
// `{"type":"page"}` message, and the relay lends the DO a fresh RPC leg by
// re-dialing `openConnection({ replayAfterOffset })`. The client's Cap'n Web
// session never observes this cycle.
//
// Two Pages cross the Pager, both DO → relay, both fire-and-forget
// JSON: `{"type":"idle"}` when idle teardown severed the RPC leg — the relay
// must dispose its StreamConnectionHandle stub, whose reference into the DO's
// isolate would otherwise keep blocking hibernation all by itself — and
// `{"type":"page"}` when a matching append lands while dormant. Catch-up
// correctness never depends on a Page arriving: the re-dial replays from the
// relay's delivered cursor.
//
// The transport mechanics are shared with capability-host provider Pagers in
// hibernatable-pager.ts. Delete the stream adapter and relay when native
// hibernatable RPC ships: the retained callback then survives hibernation on
// its own and the Pager is redundant.

import { z } from "zod";
import type { StreamEvent } from "iterate/processors";
import { HibernatablePagers } from "../hibernatable-pager.ts";
import { compileEventFilter, EventFilter } from "./event-filter.ts";

/** Internal upgrade header carrying the stream-subscriber-pager binding; never routed from external requests. */
export const STREAM_SUBSCRIBER_PAGER_HEADER = "x-iterate-stream-subscriber-pager";

/** The hibernation tag every Stream Subscriber Pager is accepted under. */
const SUBSCRIBER_PAGER_TAG = "stream-subscriber-pager";

/** The JSON body of {@link STREAM_SUBSCRIBER_PAGER_HEADER} on the upgrade request. */
const StreamSubscriberPagerUpgrade = z
  .object({
    connectionKey: z.string().trim().min(1),
    /**
     * Relay-generated unique id for this exact socket. `bind` keeps the socket
     * whose id its relay dialed with and closes every other socket under the
     * same connectionKey: a same-key replacement must leave the losing relay's
     * socket closed (its relay then breaks, matching today's last-writer-wins
     * handle death) instead of dormant — a dormant loser would be Paged on every
     * append and fight the winner with alternating re-dials forever.
     */
    pagerId: z.string().trim().min(1),
  })
  .transform(({ connectionKey, pagerId }) => ({ pagerKey: connectionKey, pagerId }));

/**
 * The durable per-socket state, stored via `serializeAttachment` so it
 * survives Stream DO hibernation and eviction. `idleDeliveredThrough` present
 * means the RPC leg was idle-closed and the subscriber is dormant;
 * `pageSentAtOffset` present means one Page was already sent for this
 * dormancy period (cleared when the relay's re-dial re-binds the key).
 */
const StreamSubscriberPagerAttachment = z.object({
  v: z.literal(1),
  connectionKey: z.string().min(1),
  pagerId: z.string().min(1),
  /** The connection's raw filter spec, re-checked before Paging. */
  filter: EventFilter.optional(),
  /** `false` mirrors a state-only connection (`openConnection({ events: false })`). */
  events: z.literal(false).optional(),
  idleDeliveredThrough: z.number().int().nonnegative().optional(),
  pageSentAtOffset: z.number().int().nonnegative().optional(),
});

type StreamSubscriberPagerAttachment = z.infer<typeof StreamSubscriberPagerAttachment>;

/**
 * Stream lifecycle bookkeeping never wakes a dormant subscriber. The idle
 * close itself appends `connection-closed`, every cold boot appends `woken`,
 * and a Page-driven re-dial appends `connection-opened` — Paging on any of those
 * would turn each idle close or DO boot into a resurrection of every dormant
 * subscriber (the `close → wake → open → idle-close` loop the hosted idle
 * teardown already defends against, see `runIdleTeardownNow`). A subscriber
 * whose filter explicitly names one of these types still receives it: the
 * exclusion only defers delivery to the next matching wake, where the re-dial
 * replays everything after the relay's cursor.
 */
const DORMANT_SUBSCRIBER_LIFECYCLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "events.iterate.com/stream/woken",
  "events.iterate.com/stream/connection-opened",
  "events.iterate.com/stream/connection-closed",
]);

/** The one lifecycle policy shared by hosted and session subscriber dormancy. */
export function eventCanWakeDormantSubscriber(
  eventType: string,
  explicitlyIncludedTypes: readonly string[] | undefined,
): boolean {
  return (
    !DORMANT_SUBSCRIBER_LIFECYCLE_EVENT_TYPES.has(eventType) ||
    explicitlyIncludedTypes?.includes(eventType) === true
  );
}

/** The seams {@link StreamSubscriberPagerRegistry} needs from its hosting Durable Object. */
type StreamSubscriberPagerRegistryHooks = {
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
 * All Durable-Object-side Stream Subscriber Pager mechanics: accepting a
 * client-given Pager, binding it to a connection, stamping dormancy, and
 * Paging dormant subscribers.
 * The hosting DO delegates its `fetch` upgrade and two sender hooks here; the
 * attachment is the whole durable state, so the registry itself is stateless
 * and survives eviction for free.
 */
export class StreamSubscriberPagerRegistry {
  readonly #hooks: StreamSubscriberPagerRegistryHooks;
  readonly #pagers: HibernatablePagers<StreamSubscriberPagerAttachment>;

  constructor(hooks: StreamSubscriberPagerRegistryHooks) {
    this.#hooks = hooks;
    this.#pagers = new HibernatablePagers({
      attachmentSchema: StreamSubscriberPagerAttachment,
      bindingOf: (attachment) => ({
        pagerKey: attachment.connectionKey,
        pagerId: attachment.pagerId,
      }),
      createAttachment: ({ pagerKey, pagerId }) => ({
        v: 1,
        connectionKey: pagerKey,
        pagerId,
      }),
      headerName: STREAM_SUBSCRIBER_PAGER_HEADER,
      hooks,
      lane: "stream subscriber",
      pagerTag: SUBSCRIBER_PAGER_TAG,
      upgradeSchema: StreamSubscriberPagerUpgrade,
    });
  }

  /**
   * The stream-subscriber-pager upgrade, dialed by the relay through the DO's stub (a
   * 101 response cannot cross an RPC method call, so this rides a real
   * `fetch()`). Unreachable from external requests — no ingress lane routes
   * fetches to Stream DOs — and additionally gated on the internal header.
   */
  acceptUpgrade(request: Request): Response {
    return this.#pagers.acceptUpgrade(request);
  }

  /**
   * Dormant subscribers — idle-closed connections whose subscriber is still
   * present on a Pager — for the stream's runtime debug state, so
   * presence surfaces can show them instead of rendering an idle tab as gone.
   */
  dormantRuntimeState(): Record<
    string,
    { idleDeliveredThrough: number; pageSentAtOffset?: number }
  > {
    const dormant: Record<string, { idleDeliveredThrough: number; pageSentAtOffset?: number }> = {};
    for (const { attachment } of this.#pagers.entries()) {
      if (!Number.isFinite(attachment.idleDeliveredThrough)) continue;
      if (this.#hooks.hasConnection(attachment.connectionKey)) continue;
      dormant[attachment.connectionKey] = {
        idleDeliveredThrough: attachment.idleDeliveredThrough,
        ...(Number.isFinite(attachment.pageSentAtOffset) && {
          pageSentAtOffset: attachment.pageSentAtOffset,
        }),
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
   * departed connectionKey and this Pager's id (for an idempotency key), or
   * undefined when no fact is owed.
   */
  departedOnClose(ws: WebSocket): { connectionKey: string; pagerId: string } | undefined {
    const attachment = this.#pagers.attachment(ws);
    if (!attachment || !Number.isFinite(attachment.idleDeliveredThrough)) {
      return undefined;
    }
    if (this.#hooks.hasConnection(attachment.connectionKey)) return undefined;
    return { connectionKey: attachment.connectionKey, pagerId: attachment.pagerId };
  }

  /** connectionKeys whose client has given this DO a live Pager. */
  connectionKeys(): ReadonlySet<string> {
    return new Set(this.#pagers.entries().map(({ attachment }) => attachment.connectionKey));
  }

  /**
   * Bind this connection's Pager (given by its relay just before
   * the openConnection call, or surviving a DO eviction): store the raw
   * filter spec so a dormant-period append can be matched without a live
   * connection, and clear any dormancy state from an earlier idle close.
   * Every OTHER socket under this connectionKey belongs to a replaced relay —
   * close it so that relay breaks (see {@link StreamSubscriberPagerUpgrade}).
   */
  bind(args: {
    connectionKey: string;
    subscriberPagerId: string | undefined;
    filter: EventFilter;
    events?: boolean;
  }): void {
    const hasFilter = Object.values(args.filter).some((value) => !!value);
    const claimed = this.#pagers.claim({
      pagerKey: args.connectionKey,
      pagerId: args.subscriberPagerId ?? "missing-stream-subscriber-pager-id",
    });
    if (claimed) {
      this.#pagers.stamp(claimed.ws, {
        v: 1,
        connectionKey: args.connectionKey,
        pagerId: claimed.attachment.pagerId,
        ...(hasFilter && { filter: args.filter }),
        ...(args.events === false && { events: false as const }),
      });
    }
  }

  /**
   * Idle teardown just closed these session connections; make this teardown's
   * own close facts unable to Page the subscribers they closed, and tell each
   * relay to drop its handle stub. Called AFTER the close-fact appends so the
   * stamped cursor covers their offsets, mirroring the hosted-cursor ack.
   */
  recordIdleClosed(connectionKeys: readonly string[]): void {
    const maxOffset = this.#hooks.maxOffset();
    const idled = new Set(connectionKeys);
    for (const { ws, attachment } of this.#pagers.entries()) {
      if (!idled.has(attachment.connectionKey)) continue;
      const { pageSentAtOffset: _cleared, ...rest } = attachment;
      this.#pagers.stamp(ws, { ...rest, idleDeliveredThrough: maxOffset });
      // Closing the RPC leg released the retained callback, but the relay
      // still holds its StreamConnectionHandle stub — a live reference into
      // this isolate that blocks hibernation on its own. The idle Page tells
      // the relay to dispose it; best-effort, since a broken socket already
      // means the relay's execution context (and with it the stub) is gone.
      this.#pagers.page(ws, { type: "idle" });
    }
  }

  /**
   * Offer just-committed events to dormant subscribers. The caller (the
   * sender's post-commit send check) is necessarily running inside an awake
   * DO, so no alarm is needed. At most one Page per dormancy period
   * (`pageSentAtOffset`; cleared when the relay's re-dial re-binds the key),
   * while the stream's own lifecycle facts remain excluded — Paging on those
   * is the resurrection loop documented on
   * {@link eventCanWakeDormantSubscriber}.
   * Ephemeral events do wake a matching subscriber as a best-effort latency
   * hint: the append itself places the event in this incarnation's memory and
   * a prompt re-dial can replay it from the subscriber's exact cursor. If the
   * incarnation ends first, the event is intentionally gone.
   */
  pageDormant(justCommitted: readonly StreamEvent[]): void {
    const news = justCommitted;
    if (!news.length) return;
    const pagerEntries = this.#pagers.entries();
    if (!pagerEntries.length) return;

    for (const { ws, attachment } of pagerEntries) {
      if (Number.isFinite(attachment.pageSentAtOffset)) continue;
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
        matcher = attachment.filter ? compileEventFilter(attachment.filter) : undefined;
      } catch (error) {
        // A stored spec that compiled at bind time can stop compiling under a
        // later deploy; throwing out of the post-commit send check would put
        // every append into repair backoff with the socket never culled.
        // Same degrade as a failed stamp: drop the socket, connection pins.
        console.warn("subscriber Pager filter no longer compiles; closing Pager", {
          connectionKey: attachment.connectionKey,
          error,
        });
        this.#pagers.close(ws, 1011, "filter compile failed");
        continue;
      }
      const matched = news.some((event) => {
        if (Number.isFinite(idleDeliveredThrough) && event.offset <= idleDeliveredThrough) {
          return false;
        }
        // Lifecycle facts Page only a subscriber whose filter names them.
        if (!eventCanWakeDormantSubscriber(event.type, explicitTypes)) return false;
        // A state-only connection wants any state change; a filterless one wants everything.
        if (attachment.events === false || !matcher) return true;
        try {
          return matcher.matches(event);
        } catch {
          // A condition that throws at match time is the delivery side's
          // policy decision; Page the subscriber and let delivery decide.
          return true;
        }
      });
      if (!matched) continue;
      if (!this.#pagers.page(ws, { type: "page" })) continue;
      this.#pagers.stamp(ws, {
        ...attachment,
        pageSentAtOffset: this.#hooks.maxOffset(),
      });
    }
  }
}
