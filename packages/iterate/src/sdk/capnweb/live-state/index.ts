// `iterate/sdk/capnweb` — live state end to end: the snapshot+patch wire
// protocol, the structural diff that produces patches, the client store that
// reassembles them, and the SERVER engine (`LiveState`) that holds a value
// and pushes minimal diffs to retained RPC subscribers. No socket, no keeper
// — a Worker or Durable Object can import it without dragging the browser
// session machinery into its bundle.
import { RpcTarget } from "@iterate-com/capnweb";
import type { LiveState as LiveStateEngine, LiveStateSubscription } from "./engine.ts";
import type { LiveUpdate } from "./protocol.ts";
import { isThenable } from "./retain.ts";
import type { LiveStateRpc, LiveStateSubscriptionHandle } from "./types.ts";

type LiveStateSource<State extends object> = Pick<LiveStateEngine<State>, "getState" | "subscribe">;

type RefreshingLiveStateSource<State extends object> = {
  readonly live: LiveStateSource<State>;
  loadAndRefreshLive(): void | PromiseLike<void>;
};

export { createLiveStateStore, type LiveStateStore } from "./store.ts";
export { applyPatch, diff } from "./diff.ts";
export type { LiveStatePatch, LiveUpdate } from "./protocol.ts";
export { LiveState, type LiveStateSubscription } from "./engine.ts";
export type { LiveStateRpc, LiveStateSubscriptionHandle } from "./types.ts";
export {
  disposeIgnoredRpcResult,
  isThenable,
  retainCallback,
  type RetainedCallback,
} from "./retain.ts";

/**
 * Expose mutable server state as a read-only Cap'n Web capability.
 * Pass an in-memory `LiveState`, or a stream-processor registry whose engine
 * must hydrate before its first snapshot.
 */
export class LiveStateRpcTarget<State extends object>
  extends RpcTarget
  implements LiveStateRpc<State>
{
  readonly #live: LiveStateSource<State>;
  readonly #beforeRead: (() => void | PromiseLike<void>) | undefined;

  constructor(source: LiveStateSource<State> | RefreshingLiveStateSource<State>) {
    super();
    if ("loadAndRefreshLive" in source) {
      this.#live = source.live;
      this.#beforeRead = () => source.loadAndRefreshLive();
    } else {
      this.#live = source;
      this.#beforeRead = undefined;
    }
  }

  async get() {
    const loading = this.#beforeRead?.();
    if (isThenable(loading)) await loading;
    return this.#live.getState();
  }

  async subscribe(onUpdate: (update: LiveUpdate<State>) => unknown) {
    const loading = this.#beforeRead?.();
    if (isThenable(loading)) await loading;
    return new LiveStateSubscriptionRpcTarget(this.#live.subscribe(onUpdate));
  }
}

/**
 * The wire handle for one subscription — `ping`/`unsubscribe` over RPC.
 * Exported for relays that build their subscription OUTSIDE a `LiveState`
 * engine (the worker-local liveState-socket relay) but must hand back the
 * same handle shape `LiveStateRpcTarget.subscribe` does.
 */
export class LiveStateSubscriptionRpcTarget
  extends RpcTarget
  implements LiveStateSubscriptionHandle
{
  readonly #subscription: LiveStateSubscription;

  constructor(subscription: LiveStateSubscription) {
    super();
    this.#subscription = subscription;
  }

  ping() {
    return this.#subscription.ping();
  }

  unsubscribe() {
    this.#subscription.unsubscribe();
  }

  [Symbol.dispose]() {
    this.#subscription.unsubscribe();
  }
}
