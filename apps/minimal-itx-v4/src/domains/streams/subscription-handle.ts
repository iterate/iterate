import { RpcTarget } from "cloudflare:workers";
import type { StreamSubscriptionHandle } from "./types.ts";

/**
 * RPC ownership handle for a live stream connection.
 *
 * This follows Cap'n Web/Workers RPC lifecycle conventions: returned class
 * instances are object capabilities, and `using`/`[Symbol.dispose]` releases
 * the caller's ownership of the live resource.
 *
 * Docs:
 * - https://github.com/cloudflare/capnweb#memory-management
 * - https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
 *
 * `unsubscribe()` remains the explicit, awaitable domain operation. Disposal is
 * the scoped cleanup path and calls the same captured close function. Capturing
 * the close function matters: a later subscription can reuse the same key, and
 * an old handle must not look up by key and close the replacement.
 */
export class StreamSubscriptionRpcTarget extends RpcTarget implements StreamSubscriptionHandle {
  readonly #close: () => void;
  readonly #streamMaxOffset: number;
  readonly #subscriptionKey: string;
  #closed = false;

  constructor(args: { close: () => void; streamMaxOffset: number; subscriptionKey: string }) {
    super();
    this.#close = args.close;
    this.#streamMaxOffset = args.streamMaxOffset;
    this.#subscriptionKey = args.subscriptionKey;
  }

  get subscriptionKey() {
    return this.#subscriptionKey;
  }

  get streamMaxOffset() {
    return this.#streamMaxOffset;
  }

  unsubscribe(): void {
    this.#closeOnce();
  }

  [Symbol.dispose](): void {
    this.#closeOnce();
  }

  #closeOnce(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#close();
  }
}
