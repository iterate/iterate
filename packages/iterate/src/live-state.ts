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

/** Expose mutable server state as a read-only Cap'n Web capability. */
export class LiveStateRpcTarget<State extends object>
  extends RpcTarget
  implements LiveStateRpc<State>
{
  readonly #live: Pick<LiveStateEngine<State>, "getState" | "subscribe">;

  constructor(live: Pick<LiveStateEngine<State>, "getState" | "subscribe">) {
    super();
    this.#live = live;
  }

  async get() {
    return this.#live.getState();
  }

  async subscribe(onUpdate: (update: LiveUpdate<State>) => unknown) {
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
