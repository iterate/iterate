// The wake-socket protocol between the fronting Worker's stream-connection
// relay and the Stream Durable Object.
//
// A session connection's retained processEventBatch callback is a live RPC
// capability into the Stream DO's isolate, so every open session connection
// pins the DO in memory and bills wall-clock duration for its whole life
// (Workers RPC has no hibernation — workerd #6087 tracks it). The relay in
// `StreamRpcTarget.openConnection` therefore opens a SECOND, parallel channel:
// a WebSocket dialed via the DO stub's real `fetch()` (a 101 cannot cross an
// RPC method call) and accepted with `ctx.acceptWebSocket`, which costs
// nothing while the DO hibernates. Once a session connection has a wake
// socket, the stream's idle teardown may sever the RPC leg; the socket's
// attachment remembers the delivered-through cursor and filter, and the next
// matching domain append sends one `{"type":"wake"}` frame so the relay
// re-dials `openConnection({ replayAfterOffset })`. The client's Cap'n Web
// session never observes any of this.
//
// Two frame types cross the socket, both DO → relay, both fire-and-forget
// JSON: `{"type":"idle"}` when idle teardown severed the RPC leg — the relay
// must dispose its StreamConnectionHandle stub, whose reference into the DO's
// isolate would otherwise keep blocking hibernation all by itself — and
// `{"type":"wake"}` when a matching append lands while dormant. Catch-up
// correctness never depends on a frame arriving: the re-dial replays from the
// relay's delivered cursor.
//
// Delete this module when hibernatable RPC ships: the retained callback then
// survives hibernation on its own and the wake socket is redundant.

import { z } from "zod";
import { EventFilter } from "./event-filter.ts";

/** Internal upgrade header carrying the wake-socket binding; never routed from external requests. */
export const STREAM_WAKE_SOCKET_HEADER = "x-iterate-stream-wake";

/** The hibernation tag every wake socket is accepted under. */
export const WAKE_SOCKET_TAG = "wake";

/** The JSON body of {@link STREAM_WAKE_SOCKET_HEADER} on the upgrade request. */
export const WakeSocketUpgradeHeader = z.object({
  connectionKey: z.string().trim().min(1),
  /**
   * Relay-generated unique id for this exact socket. `openConnection` binds
   * the socket whose id its relay dialed with and closes every other socket
   * under the same connectionKey: a same-key replacement must leave the
   * losing relay's socket closed (its relay then breaks, matching today's
   * last-writer-wins handle death) instead of dormant — a dormant loser
   * would wake on every append and fight the winner with alternating
   * re-dials forever.
   */
  socketId: z.string().trim().min(1),
});

/**
 * The durable per-socket state, stored via `serializeAttachment` so it
 * survives Stream DO hibernation and eviction. `idleDeliveredThrough` present
 * means the RPC leg was idle-closed and the subscriber is dormant;
 * `wakeSentAtOffset` present means one wake frame was already sent for this
 * dormancy period (cleared when `openConnection` re-binds the key).
 */
export const WakeSocketAttachment = z.object({
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

export type WakeSocketAttachment = z.infer<typeof WakeSocketAttachment>;

/**
 * A frame sent DO → relay on the wake socket. Loose objects on purpose: a
 * newer DO may add fields the relay's deploy does not know yet, and the relay
 * must keep honoring the `type` it does understand.
 */
export const WakeSocketFrame = z.union([
  z.object({ type: z.literal("wake") }),
  z.object({ type: z.literal("idle") }),
]);

export type WakeSocketFrame = z.infer<typeof WakeSocketFrame>;

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
export const WAKE_EXCLUDED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "events.iterate.com/stream/woken",
  "events.iterate.com/stream/connection-opened",
  "events.iterate.com/stream/connection-closed",
]);
