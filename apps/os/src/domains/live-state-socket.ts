// liveState over a hibernatable WebSocket — the lane that lets a WATCHED
// Durable Object leave memory.
//
// A `liveState.subscribe` forwarded over Workers RPC retains the client's
// callback inside the DO's isolate, pinning it (billable wall-clock duration)
// for the watcher's whole life — Workers RPC has no hibernation (workerd
// #6087 tracks it). This module is the alternative transport, extracted from
// the stream wake-socket work: the DO half accepts a WebSocket dialed through
// the DO stub's real `fetch()` (a 101 cannot cross an RPC method call) with
// `ctx.acceptWebSocket`, which costs nothing while the DO hibernates, and
// pushes the CURRENT liveState down every such socket whenever it changes.
// The worker half feeds a worker-local LiveState engine from those frames and
// serves the client's Cap'n Web subscription from that engine, so the DO
// holds no callback and the relay holds no DO-side stub.
//
// Every frame is the FULL state, read at send time, on one ordered socket —
// which is exactly liveState's latest-wins semantics, so there is no cursor,
// no replay, and no revision guard anywhere: a reconnect is just a fresh
// first frame. State only changes while the DO is awake, and every change
// runs the host's one materialization point, so pushing there is complete
// coverage. Outgoing frames carry no per-message request charge, and a
// hibernated DO bills no duration while its watchers stay attached — but the
// execution that materializes and sends a frame is billed like any other.
//
// Delete this module when hibernatable RPC ships: a retained callback that
// survives hibernation makes the socket redundant.

import { z } from "zod";
import { LiveState, type LiveStateSubscription, type LiveUpdate } from "iterate/sdk/capnweb";

/**
 * Internal upgrade header marking a liveState-socket dial. Presence CLAIMS
 * the request for this lane — it never continues to the host's other fetch
 * lanes (the project egress proxy, the secret substitution proxy), so an
 * internal-looking request can never alias into user egress.
 *
 * Deliberately forgeable (a plain marker, no signed token): on the two hosts
 * whose `fetch()` also serves user-influenced traffic, a user script that
 * goes out of its way to compose a WebSocket egress upgrade wearing this
 * header gets a watcher on its own project's liveState — the same data its
 * `itx.liveState` already serves it — for the lifetime of its own run. Not a
 * boundary worth crypto. REVISIT if lane payloads ever exceed what the
 * caller could read via itx (e.g. capability attenuation, or facet states
 * post-#2395): the upgrade is an unforgeable header VALUE derived from a
 * deployment secret, added in this one gate.
 */
export const LIVE_STATE_SOCKET_HEADER = "x-iterate-live-state";

/** The URL the relay dials; never routed, the header is the actual gate. */
const LIVE_STATE_SOCKET_URL = "https://live-state.internal/";

/** The hibernation tag every liveState socket is accepted under. */
const LIVE_STATE_SOCKET_TAG = "live-state";

/**
 * Trailing debounce for outgoing state frames: a busy fold burst becomes one
 * frame, and the flusher reading state AT FLUSH TIME means the coalesced
 * frame is never staler than the burst's end. Kept well under the client
 * engine's own 100ms debounce so coalescing here does not add visible lag.
 */
const FLUSH_DEBOUNCE_MS = 50;

/** How long the relay waits for the seed frame before giving up on the socket. */
const SEED_FRAME_TIMEOUT_MS = 5_000;

/**
 * A frame sent DO → relay: the full liveState, latest-wins. Loose object on
 * purpose: a newer DO may add fields the relay's deploy does not know yet,
 * and the payload stays `unknown` here — the relay feeds it to a typed engine
 * whose consumers already validate shape by use.
 */
const LiveStateSocketFrame = z.object({ type: z.literal("state"), state: z.unknown() });

/** Decode one inbound liveState-socket frame; anything unparseable is dropped whole. */
export function parseLiveStateSocketFrame(data: unknown): { state: unknown } | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const parsed = LiveStateSocketFrame.safeParse(JSON.parse(data));
    return parsed.success ? { state: parsed.data.state } : undefined;
  } catch {
    return undefined;
  }
}

/** The seams {@link LiveStateSockets} needs from its hosting Durable Object. */
type LiveStateSocketsHooks = {
  /** `ctx.getWebSockets` scoped by tag. */
  getWebSockets(tag: string): WebSocket[];
  /** `ctx.acceptWebSocket` (hibernation API). */
  acceptWebSocket(ws: WebSocket, tags: string[]): void;
  /** Current liveState, read at flush time — never captured earlier. */
  readState(): unknown;
  /**
   * Bring the state current before the post-accept seed flush — registry
   * hosts pass `registry.loadAndRefreshLive` (a cold DO's engine still holds
   * the empty placeholder until every runner loads). Also the reload arm of
   * {@link LiveStateSockets.refreshAfterAssembly}.
   */
  refresh(): void | PromiseLike<void>;
  /** `ctx.waitUntil` for the post-accept seed and skipped-assembly reload. */
  waitUntil(work: Promise<unknown>): void;
};

/**
 * The Durable-Object half: accept liveState-socket upgrades and push the
 * current state to every attached watcher when it changes. Sockets carry no
 * attachment — their existence is their whole state — so the class itself is
 * stateless and survives eviction for free.
 */
export class LiveStateSockets {
  readonly #hooks: LiveStateSocketsHooks;
  #flushTimer: ReturnType<typeof setTimeout> | undefined;
  #reloadInFlight: Promise<void> | undefined;

  constructor(hooks: LiveStateSocketsHooks) {
    this.#hooks = hooks;
  }

  /**
   * Route a liveState-socket upgrade, or return `undefined` for the host's
   * other fetch lanes. The lane header CLAIMS the request outright (see
   * {@link LIVE_STATE_SOCKET_HEADER}): no header → not ours; header without a
   * WebSocket upgrade → 400, never a fall-through to an egress/proxy lane;
   * an upgrade → accept, then seed the new socket via refresh + flush. The
   * seed rides the shared flusher — a full-state re-send to older sockets is
   * latest-wins and harmless, and a fold-driven frame landing first is an
   * equally valid seed.
   */
  async acceptUpgrade(request: Request): Promise<Response | undefined> {
    if (request.headers.get(LIVE_STATE_SOCKET_HEADER) === null) return undefined;
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json(
        { error: "the liveState lane accepts only WebSocket upgrades" },
        { status: 400 },
      );
    }
    const pair = new WebSocketPair();
    this.#hooks.acceptWebSocket(pair[1], [LIVE_STATE_SOCKET_TAG]);
    this.#hooks.waitUntil(
      Promise.resolve()
        .then(() => this.#hooks.refresh())
        .then(() => this.scheduleFlush())
        .catch((error: unknown) => this.#dropWatchers("seed refresh failed", error)),
    );
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /**
   * The ONE recovery action for "this host cannot push correct state": drop the
   * watchers. A closed socket is the relay's cue to re-dial and re-seed, and it
   * makes the subscription's `ping()` false so the client watchdog
   * re-subscribes — so a dropped watcher self-heals, while a watcher left
   * attached after a failed push is stale forever with nothing to say so.
   * Every failure path below funnels here rather than inventing its own
   * degrade, because no other repair exists on this side of the socket.
   */
  #dropWatchers(reason: string, error: unknown, sockets?: readonly WebSocket[]): void {
    console.warn("liveState watchers dropped; the relay will re-dial", { reason, error });
    for (const ws of sockets ?? this.#hooks.getWebSockets(LIVE_STATE_SOCKET_TAG)) {
      try {
        ws.close(1011, reason);
      } catch {
        // Already closing.
      }
    }
  }

  /** A platform-reported socket fault (the hosts' `webSocketError` hook). */
  socketError(error: unknown): void {
    // The socket is already failing; this only makes it explicable afterwards.
    console.warn("liveState socket reported an error", { error });
  }

  /** Whether any watcher socket is attached (state pushes wanted). */
  hasSockets(): boolean {
    return this.#hooks.getWebSockets(LIVE_STATE_SOCKET_TAG).length > 0;
  }

  /**
   * Coalesce state pushes: one trailing timer per burst, and the flusher
   * reads state AT FLUSH TIME with no await between read and send. That rule
   * is what keeps frames monotonic on each socket — a captured state value
   * flushed later could overtake a fresher send and rewind the relay.
   */
  scheduleFlush(): void {
    if (this.#flushTimer !== undefined || !this.hasSockets()) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined;
      this.#flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  /**
   * The registry's `onLiveAssembled` target. A real assembly flushes. An
   * assembly SKIPPED on the unloaded-runner wall — a fresh incarnation woken
   * by one runner's delivery while other runners are still cold — would
   * otherwise leave watchers permanently unaware of the committed change, so
   * while watchers exist it loads every runner once (single-flight); the
   * completed load re-runs assembly for real, which lands back here and
   * flushes. A reload that FAILS cannot be retried into correctness here — the
   * committed change would stay invisible until some later assembly happened
   * to succeed — so it drops the watchers and lets them re-seed from scratch.
   */
  refreshAfterAssembly(assembly: { skippedUnloadedRunners: boolean }): void {
    if (!this.hasSockets()) return;
    if (!assembly.skippedUnloadedRunners) {
      this.scheduleFlush();
      return;
    }
    if (this.#reloadInFlight !== undefined) return;
    this.#reloadInFlight = Promise.resolve()
      .then(() => this.#hooks.refresh())
      .then(() => undefined)
      .catch((error: unknown) => this.#dropWatchers("runner reload failed", error))
      .finally(() => {
        this.#reloadInFlight = undefined;
      });
    this.#hooks.waitUntil(this.#reloadInFlight);
  }

  #flush(): void {
    const sockets = this.#hooks.getWebSockets(LIVE_STATE_SOCKET_TAG);
    if (sockets.length === 0) return;
    let frame: string;
    try {
      frame = JSON.stringify({ type: "state", state: this.#hooks.readState() });
    } catch (error) {
      this.#dropWatchers("state could not be serialized", error, sockets);
      return;
    }
    for (const ws of sockets) {
      try {
        ws.send(frame);
      } catch (error) {
        // Includes the frame exceeding the platform's WebSocket message limit
        // (liveState is full-state and some hosts' state is unbounded). A
        // socket that is merely closing lands here too and is dropped anyway —
        // it was leaving regardless.
        this.#dropWatchers("frame send failed", error, [ws]);
      }
    }
  }
}

/** What {@link openRelayedLiveState} needs from a dialed upgrade response. */
type LiveStateSocketUpgrade = { status: number; webSocket?: WebSocket | null };

/**
 * Dial a host DO's liveState-socket upgrade through its stub's real `fetch()`
 * (a 101 cannot cross an RPC method call). The stub is not disposed here —
 * dial-path stubs are minted per call and the established socket owns its own
 * lifetime, mirroring the stream wake-socket dial.
 */
export async function dialLiveStateSocket(stub: {
  fetch(input: string, init?: RequestInit): Promise<LiveStateSocketUpgrade>;
}): Promise<LiveStateSocketUpgrade> {
  return await stub.fetch(LIVE_STATE_SOCKET_URL, {
    headers: { Upgrade: "websocket", [LIVE_STATE_SOCKET_HEADER]: "watch" },
  });
}

/**
 * The worker half: a worker-local liveState source for one DO host, fed by
 * the hibernatable socket instead of a retained subscription into the DO.
 *
 * `subscribe` dials the socket on first use (one in-flight dial shared by
 * concurrent subscribers), waits for the seed frame, then serves the local
 * engine; the last unsubscribe closes the socket so an unmounted panel
 * leaves no watcher the DO would keep materializing state for. A dead socket
 * makes every subscription's `ping()` false, so the client's ping watchdog
 * re-subscribes and re-dials. `get()` never touches the engine or the
 * socket — it is the caller-supplied transient read, so get-only callers
 * stay snapshot-per-read and dial nothing.
 *
 * When the socket cannot be established, `socketFailureDegrade` picks the
 * posture: `"reject"` makes `subscribe` throw so the call site can fall back
 * (the four DO hosts fall back to today's pinning subscribe — no liveness
 * regression, loudly logged); `"snapshot-only"` seeds the engine once from
 * `readSnapshot` and serves a live-shaped but push-less subscription (the
 * stream posture — stream subscriptions must never pin their DO).
 */
export function openRelayedLiveState<State extends object>(input: {
  /** Dial the host DO's liveState-socket upgrade; a fresh stub per call. */
  dialSocket: () => Promise<LiveStateSocketUpgrade>;
  /** Transient snapshot read; must dispose whatever it retains. */
  readSnapshot: () => Promise<State>;
  socketFailureDegrade: "reject" | "snapshot-only";
  /** For log lines: which host kind + name. */
  label: string;
}): {
  get(): Promise<State>;
  subscribe(sink: (update: LiveUpdate<State>) => unknown): Promise<LiveStateSubscription>;
} {
  // Placeholder until the seed applies; subscribe never attaches the engine
  // before a seed, so the placeholder is never delivered.
  const engine = new LiveState<State>({} as State);
  let socket: WebSocket | undefined;
  let pendingSubscribes = 0;
  // Memoized while a dial+seed is in flight: concurrent subscribes must share
  // one dial, or each opens its own DO-side socket and only the last keeps a
  // worker reference — the rest linger as watchers the DO keeps pushing to.
  let opening: Promise<void> | undefined;
  // Every socket this relay stops trusting, marked at the moment of
  // abandonment — seed timeout, close event, or the unwatched release below.
  // A late in-flight frame from an abandoned socket must never touch the
  // engine: after a fast unsubscribe→resubscribe, the fresh dial's seed could
  // otherwise be overwritten by an older frame the closed socket had already
  // queued — the one rewind path the one-ordered-channel design must close
  // explicitly (there is no revision guard by design). `close()` alone is not
  // the mark: its close EVENT fires after any already-queued frames.
  const abandonedSockets = new WeakSet<WebSocket>();

  const releaseSocketIfUnwatched = () => {
    if (pendingSubscribes > 0 || engine.observed || socket === undefined) return;
    const ws = socket;
    socket = undefined;
    abandonedSockets.add(ws);
    try {
      ws.close(1000, "no subscribers");
    } catch {
      // Already closed.
    }
  };

  const ensureSocketSeeded = () =>
    (opening ??= (async () => {
      try {
        // Inside the try so EVERY completion clears the memo below — a
        // memoized rejection would leave the relay permanently broken, and a
        // memoized early return would block re-dials after a socket close.
        if (socket !== undefined) return;
        const upgrade = await input.dialSocket();
        const ws = upgrade.webSocket ?? undefined;
        if (ws === undefined) {
          throw new Error(`liveState socket upgrade refused with status ${upgrade.status}`);
        }
        ws.accept();
        await new Promise<void>((resolve, reject) => {
          const fail = (reason: string) => {
            abandonedSockets.add(ws);
            try {
              ws.close(1000, reason);
            } catch {
              // Already closed.
            }
            reject(new Error(`liveState socket ${reason} for ${input.label}`));
          };
          const timer = setTimeout(() => fail("seed frame timed out"), SEED_FRAME_TIMEOUT_MS);
          ws.addEventListener("message", (event) => {
            // See abandonedSockets: no frame from a socket this relay stopped
            // trusting may touch the engine, however late it arrives.
            if (abandonedSockets.has(ws)) return;
            const frame = parseLiveStateSocketFrame(event.data);
            if (frame === undefined) return;
            // The only producer of state frames is the host DO's flusher,
            // which sends exactly what its snapshot read returns typed. The
            // protocol keeps the payload `unknown` for forward-compat across
            // deploy skew; consumers are read-only surfaces that tolerate
            // transient shape drift, so re-validating here would buy nothing
            // but a second schema to keep in sync.
            engine.setState(frame.state as State);
            clearTimeout(timer);
            resolve();
          });
          ws.addEventListener("close", () => {
            abandonedSockets.add(ws);
            if (socket === ws) socket = undefined;
            clearTimeout(timer);
            reject(new Error(`liveState socket closed before seeding for ${input.label}`));
          });
        });
        socket = ws;
        // Subscribers can vanish while the dial is in flight — a fast
        // mount/unmount is the common case — and their release no-ops while
        // `socket` is still undefined. Adopting the socket unwatched would
        // orphan it on the DO.
        releaseSocketIfUnwatched();
      } finally {
        opening = undefined;
      }
    })());

  return {
    get: () => input.readSnapshot(),
    subscribe: async (sink) => {
      pendingSubscribes += 1;
      let socketFed = true;
      try {
        try {
          await ensureSocketSeeded();
        } catch (error) {
          if (input.socketFailureDegrade === "reject") throw error;
          console.warn("liveState socket unavailable; subscription degrades to snapshot-only", {
            label: input.label,
            error,
          });
          socketFed = false;
          // A fresh transient read per degraded subscribe: the subscriber
          // still gets a current first paint, just no pushes. `ping()` stays
          // true — a false ping would make the client watchdog re-dial in a
          // loop against a host that already said no.
          engine.setState(await input.readSnapshot());
        }
        const subscription = engine.subscribe(sink);
        const dialedSocket = socket;
        const unsubscribe = () => {
          subscription.unsubscribe();
          releaseSocketIfUnwatched();
        };
        return {
          // A dead socket must fail pings even while the engine still holds
          // the subscriber: the client watchdog is the re-dial path.
          ping: () => subscription.ping() && (!socketFed || socket === dialedSocket),
          unsubscribe,
          [Symbol.dispose]: unsubscribe,
        };
      } finally {
        pendingSubscribes -= 1;
        releaseSocketIfUnwatched();
      }
    },
  };
}
