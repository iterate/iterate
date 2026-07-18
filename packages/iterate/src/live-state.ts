// `iterate/live-state` — live state end to end: the snapshot+patch wire
// protocol, the structural diff that produces patches, the client store that
// reassembles them, and the SERVER engine (`LiveState`) that holds a value
// and pushes minimal diffs to retained RPC subscribers. No socket, no keeper
// — a Worker or Durable Object can import it without dragging the browser
// session machinery into its bundle.
import { RpcTarget } from "capnweb";
import type {
  LiveState as LiveStateEngine,
  LiveStateSubscription,
} from "./itx/live-state/engine.ts";
import type { LiveUpdate } from "./itx/live-state/protocol.ts";
import type { LiveStateRpc, LiveStateSubscriptionHandle } from "./processors/rpc-types.ts";

type LiveStateSource<State extends object> = Pick<LiveStateEngine<State>, "getState" | "subscribe">;

type RefreshingLiveStateSource<State extends object> = {
  readonly live: LiveStateSource<State>;
  loadAndRefreshLive(): void | PromiseLike<void>;
};

export { createLiveStateStore } from "./itx/live-state/store.ts";
export { applyPatch, diff } from "./itx/live-state/diff.ts";
export type { LiveStatePatch, LiveUpdate } from "./itx/live-state/protocol.ts";
export { LiveState, type LiveStateSubscription } from "./itx/live-state/engine.ts";
export type { LiveStateRpc, LiveStateSubscriptionHandle } from "./processors/rpc-types.ts";
export {
  disposeIgnoredRpcResult,
  isThenable,
  retainCallback,
  type RetainedCallback,
} from "./itx/rpc/retain.ts";

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
    await this.#beforeRead?.();
    return this.#live.getState();
  }

  async subscribe(onUpdate: (update: LiveUpdate<State>) => unknown) {
    await this.#beforeRead?.();
    return new LiveStateSubscriptionRpcTarget(this.#live.subscribe(onUpdate));
  }
}

class LiveStateSubscriptionRpcTarget extends RpcTarget implements LiveStateSubscriptionHandle {
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
