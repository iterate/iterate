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
// coverage; outgoing sends are billing-free.
//
// Delete this module when hibernatable RPC ships: a retained callback that
// survives hibernation makes the socket redundant.

import { z } from "zod";
import { LiveState, type LiveStateSubscription, type LiveUpdate } from "iterate/sdk/capnweb";

/**
 * Internal upgrade header carrying the liveState-socket lane token. Unlike
 * the stream wake-socket header (whose hosts are unreachable from user
 * traffic), some hosting DOs' `fetch()` also serves user-influenced requests
 * (the project egress lane, the secret substitution proxy) where a user
 * script controls arbitrary headers — so presence alone can never open the
 * lane; the VALUE must match {@link liveStateLaneToken}.
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
 * The deploy-internal lane token: user code can reach some hosts' `fetch()`
 * with arbitrary headers but can never read deployment secrets, so an HMAC of
 * a fixed label under `SECRET_ENCRYPTION_KEY` is unforgeable from user space
 * while needing no new binding or storage. Memoized per isolate — both ends
 * of the dial run the same deploy.
 */
let laneTokenMemo: Promise<string> | undefined;
export function liveStateLaneToken(env: { SECRET_ENCRYPTION_KEY: string }): Promise<string> {
  return (laneTokenMemo ??= (async () => {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(env.SECRET_ENCRYPTION_KEY),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, encoder.encode("live-state-socket-lane"));
    return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("");
  })());
}

/** Constant-time-ish string compare; the compared values are fixed-length HMAC hex. */
function tokenMatches(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

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
  /** The deploy-internal lane token ({@link liveStateLaneToken}). */
  laneToken(): Promise<string>;
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
   * other fetch lanes. Three-way gate: no lane header → not ours; header with
   * a wrong token → 403 and NEVER falls through (a request wearing the
   * internal header must not reach an egress/proxy lane); valid token →
   * accept, then seed the new socket via refresh + flush. The seed rides the
   * shared flusher — a full-state re-send to older sockets is latest-wins and
   * harmless, and a fold-driven frame landing first is an equally valid seed.
   */
  async acceptUpgrade(request: Request): Promise<Response | undefined> {
    const presented = request.headers.get(LIVE_STATE_SOCKET_HEADER);
    if (presented === null) return undefined;
    if (!tokenMatches(presented, await this.#hooks.laneToken())) {
      console.warn("liveState socket upgrade presented an invalid lane token");
      return Response.json({ error: "invalid liveState lane token" }, { status: 403 });
    }
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
        .catch((error) => {
          // The relay is awaiting its seed frame; failing the socket promptly
          // beats letting that wait run into its timeout.
          console.warn("liveState socket seed refresh failed; closing socket", { error });
          try {
            pair[1].close(1011, "seed refresh failed");
          } catch {
            // Already closing.
          }
        }),
    );
    return new Response(null, { status: 101, webSocket: pair[0] });
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
   * flushes.
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
      .catch((error: unknown) => {
        console.warn("liveState reload after runner-wall-skipped assembly failed", { error });
      })
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
      console.warn("liveState flush could not materialize state", { error });
      return;
    }
    for (const ws of sockets) {
      try {
        ws.send(frame);
      } catch {
        // A closing socket drops off getWebSockets on its own.
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
export async function dialLiveStateSocket(
  stub: { fetch(input: string, init?: RequestInit): Promise<LiveStateSocketUpgrade> },
  env: { SECRET_ENCRYPTION_KEY: string },
): Promise<LiveStateSocketUpgrade> {
  return await stub.fetch(LIVE_STATE_SOCKET_URL, {
    headers: {
      Upgrade: "websocket",
      [LIVE_STATE_SOCKET_HEADER]: await liveStateLaneToken(env),
    },
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
