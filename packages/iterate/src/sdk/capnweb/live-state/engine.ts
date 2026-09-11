import {
  disposeIgnoredRpcResult,
  isThenable,
  retainCallback,
  type RetainedCallback,
} from "./retain.ts";
import { diff } from "./diff.ts";
import type {
  LiveStateCursor,
  LiveStateRead,
  LiveStateSubscriptionOptions,
  LiveUpdate,
} from "./protocol.ts";

/** Handle returned by `LiveState.subscribe` — the ownership + liveness surface for one subscriber. */
export type LiveStateSubscription = {
  /** Still registered on a live engine? A dead DO incarnation also makes the call reject. */
  ping(): boolean;
  unsubscribe(): void;
  [Symbol.dispose](): void;
};

const DEFAULT_DEBOUNCE_MS = 100;
const ACK_TIMEOUT_MS = 10_000;

type Subscriber<State> = {
  version: 1 | 2;
  state: State;
  revision: number;
  busy: boolean;
  timeout?: ReturnType<typeof setTimeout>;
};

/**
 * A source-agnostic live store: hold a state value, and when it changes push the
 * minimal diff to every subscriber. It does not know or care where the state
 * comes from — a Durable Object folds events into it, a stateless RpcTarget polls
 * a third-party API into it — so ANY RpcTarget can expose live state by holding
 * one and returning a read-only wrapper from a `.live` getter.
 *
 * Two rules make it cheap and correct:
 * - Updates are IMMUTABLE (`setState`/`assign` build a new value, never mutate),
 *   so the diff short-circuits unchanged branches by identity — O(changed), not
 *   O(size). See `diff.ts`.
 * - Push work runs only while a subscriber exists. Transient readers call
 *   `readSince` explicitly; a dormant engine schedules nothing.
 *
 * All subscribers share one revision line. Fast subscribers share a patch;
 * slow subscribers receive a coalesced patch from their acknowledged state.
 * A revision mismatch makes the client resync instead of applying stale data.
 */
export class LiveState<State extends object> {
  #current: State;
  /** Latest flushed state — the shared diff baseline. */
  #broadcast: State;
  #revision = 0;
  readonly #epoch = crypto.randomUUID();
  #lastUpdate: Extract<LiveUpdate<State>, { type: "patch" }> | undefined;
  readonly #subscribers = new Map<RetainedCallback<LiveUpdate<State>>, Subscriber<State>>();
  readonly #debounceMs: number;
  #flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(initial: State, options: { debounceMs?: number } = {}) {
    this.#current = initial;
    this.#broadcast = initial;
    this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /** The current state — reflects every `setState`/`assign`, even while dormant. */
  getState(): State {
    return this.#current;
  }

  /** One retained delta bounds history while a single parent can pull incrementally.
   * A late reader or a new incarnation receives an explicit snapshot instead. */
  readSince(cursor?: LiveStateCursor): LiveStateRead<State> {
    if (this.#flushTimer !== undefined) clearTimeout(this.#flushTimer);
    this.#flushTimer = undefined;
    this.#flush();
    if (cursor?.epoch === this.#epoch) {
      if (cursor.revision === this.#revision) return { epoch: this.#epoch, update: null };
      if (cursor.revision === this.#lastUpdate?.from) {
        return { epoch: this.#epoch, update: this.#lastUpdate };
      }
    }
    return {
      epoch: this.#epoch,
      update: { type: "snapshot", revision: this.#revision, state: this.#broadcast },
    };
  }

  /** True while at least one live subscriber makes projection work observable. */
  get observed(): boolean {
    return this.#subscribers.size > 0;
  }

  /** Replace the state. Build a NEW value (don't mutate) so the diff stays cheap. */
  setState(next: State | ((prev: State) => State)): void {
    this.#current = typeof next === "function" ? next(this.#current) : next;
    if (this.#subscribers.size > 0) this.#scheduleFlush();
  }

  /** Shallow-merge a partial into the state — sugar for `setState(p => ({ ...p, ...partial }))`. */
  assign(partial: Partial<State>): void {
    this.setState((prev) => ({ ...prev, ...partial }));
  }

  subscribe(
    sink: (update: LiveUpdate<State>) => unknown,
    options: LiveStateSubscriptionOptions = {},
  ): LiveStateSubscription {
    // First subscriber after dormancy: adopt the latest state as the shared
    // baseline. While subscribers exist, `#broadcast` only advances inside a
    // flush (with a patch to everyone), so it always matches what they've seen.
    if (this.#subscribers.size === 0) {
      this.#flush();
    }

    const retained = retainCallback(sink);
    this.#subscribers.set(retained, {
      version: options.patchVersion ?? 1,
      state: this.#broadcast,
      revision: this.#revision,
      busy: false,
    });
    retained.onRpcBroken?.(() => this.#drop(retained));
    // The initial snapshot is the first paint — delivered now, never debounced.
    // A synchronously-throwing sink is dropped here and never becomes live.
    this.#deliver(retained, { type: "snapshot", revision: this.#revision, state: this.#broadcast });

    return {
      ping: () => this.#subscribers.has(retained),
      unsubscribe: () => this.#drop(retained),
      [Symbol.dispose]: () => this.#drop(retained),
    };
  }

  #scheduleFlush(): void {
    this.#flushTimer ??= setTimeout(() => {
      this.#flushTimer = undefined;
      this.#flush();
    }, this.#debounceMs);
  }

  #flush(): void {
    const previous = this.#broadcast;
    const patch = diff(previous, this.#current);
    if (patch === undefined) return;
    const from = this.#revision;
    const to = (this.#revision += 1);
    this.#broadcast = this.#current;
    const update = { type: "patch", from, to, patch } satisfies LiveUpdate<State>;
    this.#lastUpdate = update;
    for (const subscriber of this.#subscribers.keys()) {
      this.#sendLatest(subscriber);
    }
  }

  /** Slow subscribers hold one call and one baseline, never a queue of token updates. */
  #sendLatest(subscriber: RetainedCallback<LiveUpdate<State>>): void {
    const held = this.#subscribers.get(subscriber);
    if (!held || held.busy || held.revision === this.#revision) return;
    const patch =
      held.version === 2 && held.revision === this.#lastUpdate?.from
        ? this.#lastUpdate.patch
        : diff(held.state, this.#broadcast, { arrays: held.version === 2 });
    // A coalesced sequence may return to the same value. An empty object patch
    // still advances its revision so the following shared update applies.
    this.#deliver(subscriber, {
      type: "patch",
      from: held.revision,
      to: this.#revision,
      patch: patch ?? {},
    });
  }

  /** Only acknowledgement releases the next coalesced update; a dead sink is dropped. */
  #deliver(subscriber: RetainedCallback<LiveUpdate<State>>, update: LiveUpdate<State>): void {
    const held = this.#subscribers.get(subscriber);
    if (!held) return;
    held.state = this.#broadcast;
    held.revision = this.#revision;
    held.busy = true;
    let result: unknown;
    try {
      result = subscriber(update);
    } catch {
      this.#drop(subscriber);
      return;
    }
    if (isThenable(result)) {
      held.timeout = setTimeout(() => {
        console.warn("Live-state subscriber dropped: acknowledgement timed out", {
          revision: held.revision,
          timeoutMs: ACK_TIMEOUT_MS,
        });
        this.#drop(subscriber);
      }, ACK_TIMEOUT_MS);
      void Promise.resolve(result)
        .then(
          () => {
            if (held.timeout !== undefined) clearTimeout(held.timeout);
            held.busy = false;
            this.#sendLatest(subscriber);
          },
          () => this.#drop(subscriber),
        )
        .finally(() => disposeIgnoredRpcResult(result));
      return;
    }
    held.busy = false;
    disposeIgnoredRpcResult(result);
  }

  #drop(subscriber: RetainedCallback<LiveUpdate<State>>): void {
    const timeout = this.#subscribers.get(subscriber)?.timeout;
    if (timeout !== undefined) clearTimeout(timeout);
    if (!this.#subscribers.delete(subscriber)) return;
    subscriber[Symbol.dispose]();
    if (this.#subscribers.size === 0 && this.#flushTimer !== undefined) {
      clearTimeout(this.#flushTimer); // dormant again: no work until the next subscriber
      this.#flushTimer = undefined;
    }
  }
}
