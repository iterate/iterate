import { RpcTarget } from "capnweb";
import { retainCallback, type RetainedCallback } from "../rpc/retain.ts";
import type { LiveState, LiveStateSubscription } from "./engine.ts";
import type { LiveUpdate } from "./protocol.ts";

/** Live ownership handle returned to a Cap'n Web subscriber. */
export type LiveStateSubscriptionHandle = Disposable & {
  ping(): boolean | Promise<boolean>;
  unsubscribe(): void;
};

/** Read-only wire view of a server-owned {@link LiveState}. */
export interface LiveStateRpc<State = unknown> {
  get(): Promise<State>;
  subscribe(onUpdate: (update: LiveUpdate<State>) => unknown): Promise<LiveStateSubscriptionHandle>;
}

export type LiveStateRpcTargetOptions = {
  /**
   * Re-check the authority behind this view before reads, subscriptions, and
   * every later push. Throwing drops the live subscription and releases its
   * remote callback.
   */
  authorize?: () => void;
};

/**
 * Expose a mutable server-side LiveState as a read-only object capability.
 * The engine itself never crosses RPC, so `setState()` and `assign()` remain
 * local authority held by the application.
 */
export class LiveStateRpcTarget<State extends object>
  extends RpcTarget
  implements LiveStateRpc<State>
{
  readonly #live: Pick<LiveState<State>, "getState" | "subscribe">;
  readonly #authorize: (() => void) | undefined;

  constructor(
    live: Pick<LiveState<State>, "getState" | "subscribe">,
    options: LiveStateRpcTargetOptions = {},
  ) {
    super();
    this.#live = live;
    this.#authorize = options.authorize;
  }

  async get(): Promise<State> {
    this.#authorize?.();
    return this.#live.getState();
  }

  async subscribe(
    onUpdate: (update: LiveUpdate<State>) => unknown,
  ): Promise<LiveStateSubscriptionHandle> {
    this.#authorize?.();
    if (this.#authorize === undefined) {
      return new LiveStateSubscriptionRpcTarget(this.#live.subscribe(onUpdate));
    }

    // Retain the REMOTE callback before adding the local authorization
    // wrapper. If LiveState retained only that wrapper, Cap'n Web would release
    // `onUpdate` when this RPC call returned: the synchronous snapshot would
    // work, but every later patch would target a disposed stub.
    const retained = retainCallback(onUpdate);
    const authorize = this.#authorize;
    const onRpcBroken = retained.onRpcBroken;
    const guarded = Object.assign(
      (update: LiveUpdate<State>) => {
        authorize();
        return retained(update);
      },
      {
        [Symbol.dispose]: () => retained[Symbol.dispose](),
        ...(onRpcBroken === undefined
          ? {}
          : {
              onRpcBroken: (handler: (error: unknown) => void) => onRpcBroken(handler),
            }),
      },
    ) as RetainedCallback<LiveUpdate<State>>;
    try {
      return new LiveStateSubscriptionRpcTarget(this.#live.subscribe(guarded));
    } catch (error) {
      guarded[Symbol.dispose]();
      throw error;
    }
  }
}

class LiveStateSubscriptionRpcTarget extends RpcTarget implements LiveStateSubscriptionHandle {
  readonly #subscription: LiveStateSubscription;

  constructor(subscription: LiveStateSubscription) {
    super();
    this.#subscription = subscription;
  }

  ping(): boolean {
    return this.#subscription.ping();
  }

  unsubscribe(): void {
    this.#subscription.unsubscribe();
  }

  [Symbol.dispose](): void {
    this.#subscription.unsubscribe();
  }
}
