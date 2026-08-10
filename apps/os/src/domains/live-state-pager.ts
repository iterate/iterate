// The Live State Pager: a client-given hibernatable return channel that lets a
// WATCHED Durable Object leave memory.
//
// A `liveState.subscribe` forwarded over Workers RPC retains the client's
// callback inside the DO's isolate, pinning it (billable wall-clock duration)
// for the watcher's whole life — Workers RPC has no hibernation (workerd
// #6087 tracks it). Instead, the client relay gives the DO a WebSocket dialed
// through
// the DO stub's real `fetch()` (a 101 cannot cross an RPC method call) with
// `ctx.acceptWebSocket`, which costs nothing while the DO hibernates, and
// Pages the CURRENT liveState down that return channel whenever it changes:
// "you may release my callback; Page my relay here with the latest state."
// The worker half feeds a worker-local LiveState engine from those Pages and
// serves the client's Cap'n Web subscription from that engine, so the DO
// holds no callback and the relay holds no DO-side stub.
//
// Every Page is the FULL state, read at send time, on one ordered Pager —
// which is exactly liveState's latest-wins semantics, so there is no cursor,
// no replay, and no revision guard anywhere: a reconnect is just a fresh
// first Page. State only changes while the DO is awake, and every change
// runs the host's one materialization point, so pushing there is complete
// coverage. Outgoing Pages carry no per-message request charge, and a
// hibernated DO bills no duration while its watchers stay attached — but the
// execution that materializes and sends a Page is billed like any other.
//
// Delete this module when hibernatable RPC ships: a retained callback that
// survives hibernation makes the Pager redundant.

import { z } from "zod";
import { LiveState, type LiveStateSubscription, type LiveUpdate } from "iterate/sdk/capnweb";

/**
 * Internal upgrade header marking a Live State Pager dial. Presence CLAIMS
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
 * caller could read via itx (e.g. capability attenuation): the upgrade is an
 * unforgeable header VALUE derived from a deployment secret, added in this
 * one gate. (The facet-processor lanes are keyed lanes on STREAM Durable
 * Objects, which no user-influenced fetch can reach — no change to this
 * posture.)
 */
export const LIVE_STATE_PAGER_HEADER = "x-iterate-live-state-pager";

/** The URL the relay dials; never routed, the header is the actual gate. */
const LIVE_STATE_PAGER_URL = "https://live-state-pager.internal/";

/** The hibernation tag every Live State Pager is accepted under. */
const LIVE_STATE_PAGER_TAG = "live-state-pager";

/**
 * The hibernation tag for one KEYED lane's Pagers. A host that serves more
 * than one liveState (the Stream DO: its own runtime debug state plus one
 * lane per facet-hosted processor, keyed by subscription name) runs one
 * {@link LiveStatePagers} per lane and namespaces the tag so each instance
 * only ever sees its own watchers.
 */
export function liveStatePagerLaneTag(lane: string): string {
  return `${LIVE_STATE_PAGER_TAG}:${lane}`;
}

/**
 * Recover the lane key from a hibernated Pager's tag on a fresh incarnation
 * (`ctx.getTags(ws)`), so a host can rebuild its per-lane
 * {@link LiveStatePagers} instances for watchers that attached in an earlier
 * incarnation. `undefined` for the unkeyed tag and for foreign tags (e.g. the
 * Stream Subscriber Pager lane's).
 */
export function parseLiveStatePagerLaneTag(tag: string): string | undefined {
  const prefix = `${LIVE_STATE_PAGER_TAG}:`;
  return tag.startsWith(prefix) ? tag.slice(prefix.length) : undefined;
}

/**
 * Read the lane key a dial put on the upgrade URL, or `undefined` for the
 * unkeyed (host's own state) lane. The header still claims the request — the
 * URL only selects WHICH lane serves it, so a host routes: header absent →
 * not ours; lane key → that lane's `acceptUpgrade`; no key → the default.
 */
export function liveStatePagerLaneKey(request: Request): string | undefined {
  const match = /^\/lane\/(.+)$/.exec(new URL(request.url).pathname);
  return match === null ? undefined : decodeURIComponent(match[1]!);
}

/**
 * Trailing debounce for outgoing state Pages: a busy fold burst becomes one
 * Page, and the flusher reading state AT FLUSH TIME means the coalesced
 * Page is never staler than the burst's end. Kept well under the client
 * engine's own 100ms debounce so coalescing here does not add visible lag.
 */
const FLUSH_DEBOUNCE_MS = 50;

/** How long the relay waits for the seed Page before giving up on the Pager. */
const SEED_PAGE_TIMEOUT_MS = 5_000;

/**
 * A Page sent DO → relay: the full liveState, latest-wins. Loose object on
 * purpose: a newer DO may add fields the relay's deploy does not know yet,
 * and the payload stays `unknown` here — the relay feeds it to a typed engine
 * whose consumers already validate shape by use.
 */
const LiveStatePage = z.object({ type: z.literal("state"), state: z.unknown() });

/** Decode one Live State Page; anything unparseable is dropped whole. */
export function parseLiveStatePage(data: unknown): { state: unknown } | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const parsed = LiveStatePage.safeParse(JSON.parse(data));
    return parsed.success ? { state: parsed.data.state } : undefined;
  } catch {
    return undefined;
  }
}

/** The seams {@link LiveStatePagers} needs from its hosting Durable Object. */
type LiveStatePagersHooks = {
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
   * {@link LiveStatePagers.refreshAfterAssembly}.
   */
  refresh(): void | PromiseLike<void>;
  /** `ctx.waitUntil` for the post-accept seed and skipped-assembly reload. */
  waitUntil(work: Promise<unknown>): void;
};

/**
 * The Durable-Object half: accept client-given Live State Pagers and Page the
 * current state to every attached watcher when it changes. Pagers carry no
 * attachment — their existence is their whole state — so the class itself is
 * stateless and survives eviction for free.
 */
export class LiveStatePagers {
  readonly #hooks: LiveStatePagersHooks;
  #flushTimer: ReturnType<typeof setTimeout> | undefined;
  #reloadInFlight: Promise<void> | undefined;
  #externalRefresh: Promise<void> | undefined;
  #externalRefreshAgain = false;

  constructor(hooks: LiveStatePagersHooks) {
    this.#hooks = hooks;
  }

  /**
   * Route a Live State Pager upgrade, or return `undefined` for the host's
   * other fetch lanes. The lane header CLAIMS the request outright (see
   * {@link LIVE_STATE_PAGER_HEADER}): no header → not ours; header without a
   * WebSocket upgrade → 400, never a fall-through to an egress/proxy lane;
   * an upgrade → accept, then seed the new socket via refresh + flush. The
   * seed rides the shared flusher — a full-state re-send to older sockets is
   * latest-wins and harmless, and a fold-driven Page landing first is an
   * equally valid seed.
   */
  async acceptUpgrade(request: Request): Promise<Response | undefined> {
    if (request.headers.get(LIVE_STATE_PAGER_HEADER) === null) return undefined;
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json(
        { error: "the Live State Pager lane accepts only WebSocket upgrades" },
        { status: 400 },
      );
    }
    const pair = new WebSocketPair();
    this.#hooks.acceptWebSocket(pair[1], [LIVE_STATE_PAGER_TAG]);
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
   * watchers. A closed Pager is the relay's cue to re-dial and re-seed, and it
   * makes the subscription's `ping()` false so the client watchdog
   * re-subscribes — so a dropped watcher self-heals, while a watcher left
   * attached after a failed push is stale forever with nothing to say so.
   * Every failure path below funnels here rather than inventing its own
   * degrade, because no other repair exists on this side of the socket.
   */
  #dropWatchers(reason: string, error: unknown, sockets?: readonly WebSocket[]): void {
    console.warn("liveState watchers dropped; the relay will re-dial", { reason, error });
    for (const ws of sockets ?? this.#hooks.getWebSockets(LIVE_STATE_PAGER_TAG)) {
      try {
        ws.close(1011, reason);
      } catch {
        // Already closing.
      }
    }
  }

  /** A platform-reported Pager fault (the hosts' `webSocketError` hook). */
  pagerError(error: unknown): void {
    // The Pager is already failing; this only makes it explicable afterwards.
    console.warn("Live State Pager reported an error", { error });
  }

  /** Whether any watcher has given this DO a Pager (state pushes wanted). */
  hasPagers(): boolean {
    return this.#hooks.getWebSockets(LIVE_STATE_PAGER_TAG).length > 0;
  }

  /**
   * Coalesce state pushes: one trailing timer per burst, and the flusher
   * reads state AT FLUSH TIME with no await between read and send. That rule
   * is what keeps Pages monotonic on each Pager — a captured state value
   * flushed later could overtake a fresher send and rewind the relay.
   */
  scheduleFlush(): void {
    if (this.#flushTimer !== undefined || !this.hasPagers()) return;
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
    if (!this.hasPagers()) return;
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

  /**
   * The change trigger for hosts whose state is materialized OUTSIDE this
   * Durable Object — the stream's facet lanes, where `readState` returns a
   * parent-held cache and `refresh` pulls the facet's current live state into
   * it. Where {@link scheduleFlush} assumes the state is already current at
   * flush time, this runs `refresh` FIRST, then flushes; single-flight with a
   * trailing re-run so a trigger landing mid-refresh still produces one more
   * refresh that starts after it (the in-flight pull may have read state from
   * before the triggering change — without the re-run that change would stay
   * invisible until the next trigger). A refresh that FAILS drops the
   * watchers, the one repair (see {@link #dropWatchers}).
   */
  refreshThenFlush(): void {
    if (!this.hasPagers()) return;
    if (this.#externalRefresh !== undefined) {
      this.#externalRefreshAgain = true;
      return;
    }
    this.#externalRefresh = (async () => {
      try {
        do {
          this.#externalRefreshAgain = false;
          await this.#hooks.refresh();
        } while (this.#externalRefreshAgain);
        this.scheduleFlush();
      } catch (error) {
        this.#dropWatchers("refresh failed", error);
      } finally {
        this.#externalRefresh = undefined;
      }
    })();
    this.#hooks.waitUntil(this.#externalRefresh);
  }

  #flush(): void {
    const sockets = this.#hooks.getWebSockets(LIVE_STATE_PAGER_TAG);
    if (sockets.length === 0) return;
    let page: string;
    try {
      page = JSON.stringify({ type: "state", state: this.#hooks.readState() });
    } catch (error) {
      this.#dropWatchers("state could not be serialized", error, sockets);
      return;
    }
    for (const ws of sockets) {
      try {
        ws.send(page);
      } catch (error) {
        // Includes the Page exceeding the platform's WebSocket message limit
        // (liveState is full-state and some hosts' state is unbounded). A
        // socket that is merely closing lands here too and is dropped anyway —
        // it was leaving regardless.
        this.#dropWatchers("Page send failed", error, [ws]);
      }
    }
  }
}

/** What {@link openRelayedLiveState} needs from a dialed upgrade response. */
export type LiveStatePagerUpgrade = { status: number; webSocket?: WebSocket | null };

/**
 * Give a host DO a Live State Pager through its stub's real `fetch()`
 * (a 101 cannot cross an RPC method call). The stub is not disposed here —
 * dial-path stubs are minted per call and the established socket owns its own
 * lifetime, mirroring the Stream Subscriber Pager dial. `lane` selects a
 * keyed lane on a multi-lane host (see {@link liveStatePagerLaneKey});
 * omitted, the host's own (unkeyed) state lane answers.
 */
export async function dialLiveStatePager(
  stub: {
    fetch(input: string, init?: RequestInit): Promise<LiveStatePagerUpgrade>;
  },
  options?: { lane?: string },
): Promise<LiveStatePagerUpgrade> {
  const url =
    options?.lane === undefined
      ? LIVE_STATE_PAGER_URL
      : `${LIVE_STATE_PAGER_URL}lane/${encodeURIComponent(options.lane)}`;
  return await stub.fetch(url, {
    headers: { Upgrade: "websocket", [LIVE_STATE_PAGER_HEADER]: "watch" },
  });
}

/**
 * The worker half: a worker-local liveState source for one DO host, fed by
 * the client-given hibernatable Pager instead of a retained subscription into the DO.
 *
 * `subscribe` dials the socket on first use (one in-flight dial shared by
 * concurrent subscribers), waits for the seed Page, then serves the local
 * engine; the last unsubscribe closes the socket so an unmounted panel
 * leaves no watcher the DO would keep materializing state for. A dead socket
 * makes every subscription's `ping()` false, so the client's ping watchdog
 * re-subscribes and re-dials. `get()` never touches the engine or the
 * socket — it is the caller-supplied transient read, so get-only callers
 * stay snapshot-per-read and dial nothing.
 *
 * When the Pager cannot be established, `pagerFailureDegrade` picks the
 * posture: `"reject"` makes `subscribe` throw so the call site can fall back
 * (the four DO hosts fall back to today's pinning subscribe — no liveness
 * regression, loudly logged); `"snapshot-only"` seeds the engine once from
 * `readSnapshot` and serves a live-shaped but push-less subscription (the
 * stream posture — stream subscriptions must never pin their DO).
 */
export function openRelayedLiveState<State extends object>(input: {
  /** Give the host DO a fresh Live State Pager. */
  dialPager: () => Promise<LiveStatePagerUpgrade>;
  /** Transient snapshot read; must dispose whatever it retains. */
  readSnapshot: () => Promise<State>;
  pagerFailureDegrade: "reject" | "snapshot-only";
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
  // A late in-flight Page from an abandoned Pager must never touch the
  // engine: after a fast unsubscribe→resubscribe, the fresh dial's seed could
  // otherwise be overwritten by an older Page the closed Pager had already
  // queued — the one rewind path the one-ordered-channel design must close
  // explicitly (there is no revision guard by design). `close()` alone is not
  // the mark: its close EVENT fires after any already-queued Pages.
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
        const upgrade = await input.dialPager();
        const ws = upgrade.webSocket ?? undefined;
        if (ws === undefined) {
          throw new Error(`Live State Pager upgrade refused with status ${upgrade.status}`);
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
            reject(new Error(`Live State Pager ${reason} for ${input.label}`));
          };
          const timer = setTimeout(() => fail("seed Page timed out"), SEED_PAGE_TIMEOUT_MS);
          ws.addEventListener("message", (event) => {
            // See abandonedSockets: no Page from a Pager this relay stopped
            // trusting may touch the engine, however late it arrives.
            if (abandonedSockets.has(ws)) return;
            const page = parseLiveStatePage(event.data);
            if (page === undefined) return;
            // The only producer of state Pages is the host DO's flusher,
            // which sends exactly what its snapshot read returns typed. The
            // protocol keeps the payload `unknown` for forward-compat across
            // deploy skew; consumers are read-only surfaces that tolerate
            // transient shape drift, so re-validating here would buy nothing
            // but a second schema to keep in sync.
            engine.setState(page.state as State);
            clearTimeout(timer);
            resolve();
          });
          ws.addEventListener("close", () => {
            abandonedSockets.add(ws);
            if (socket === ws) socket = undefined;
            clearTimeout(timer);
            reject(new Error(`Live State Pager closed before seeding for ${input.label}`));
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
          if (input.pagerFailureDegrade === "reject") throw error;
          console.warn("Live State Pager unavailable; subscription degrades to snapshot-only", {
            label: input.label,
            error,
          });
          socketFed = false;
          // A fresh transient read per degraded subscribe, so the subscriber
          // still gets a current first paint — it just will not receive pushes.
          engine.setState(await input.readSnapshot());
        }
        const subscription = engine.subscribe(sink);
        const dialedSocket = socket;
        const unsubscribe = () => {
          subscription.unsubscribe();
          releaseSocketIfUnwatched();
        };
        return {
          // `ping()` answers one question: is this subscription still being
          // fed? A subscription whose socket died — or that never got one and
          // is serving a frozen degraded snapshot — must answer NO even though
          // the engine still holds it, because the owner's watchdog is the only
          // path back to live data. Reporting a frozen subscription healthy
          // leaves a page silently stale forever; reporting it unhealthy costs
          // one re-dial per watchdog interval (45s in `useLiveState`) until the
          // host can serve a socket again.
          ping: () => subscription.ping() && socketFed && socket === dialedSocket,
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
