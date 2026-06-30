import { RpcTarget } from "cloudflare:workers";
import type {
  CapabilityProvision,
  CfExecutionContext,
  RevokeCapabilityInput,
} from "../../types.ts";

type RevokeCapability = (input: RevokeCapabilityInput) => Promise<void>;

/**
 * Ownership handle for one `provideCapability()` call.
 *
 * Cap'n Web and Workers RPC model returned class instances as object
 * capabilities: callers hold a stub and dispose that stub when they are done.
 * See:
 * - https://github.com/cloudflare/capnweb#memory-management
 * - https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
 *
 * We still keep the explicit `revoke()` method because it is a domain operation
 * callers can await and assert on. `[Symbol.dispose]` is the lifecycle fallback
 * for scopes (`using provision = ...`) and abandoned stubs. The handle is keyed
 * by the stream offset that mounted the capability, so disposing an older
 * provision after a replacement cannot revoke the newer mount at the same path.
 */
export class CapabilityProvisionRpcTarget extends RpcTarget implements CapabilityProvision {
  readonly #ctx: Pick<CfExecutionContext, "waitUntil"> | undefined;
  readonly #path: string[];
  readonly #providedAtOffset: number;
  readonly #revoke: RevokeCapability;
  #revokePromise: Promise<void> | undefined;

  constructor(args: {
    ctx?: Pick<CfExecutionContext, "waitUntil">;
    path: string[];
    providedAtOffset: number;
    revoke: RevokeCapability;
  }) {
    super();
    this.#ctx = args.ctx;
    this.#path = [...args.path];
    this.#providedAtOffset = args.providedAtOffset;
    this.#revoke = args.revoke;
  }

  get path() {
    return [...this.#path];
  }

  get providedAtOffset() {
    return this.#providedAtOffset;
  }

  async revoke(): Promise<void> {
    await this.#startRevoke();
  }

  [Symbol.dispose](): void {
    const work = this.#startRevoke().catch((error: unknown) => {
      console.error("capability provision dispose failed", {
        error,
        path: this.#path,
        providedAtOffset: this.#providedAtOffset,
      });
    });
    this.#ctx?.waitUntil?.(work);
  }

  #startRevoke(): Promise<void> {
    this.#revokePromise ??= this.#revoke({
      path: this.#path,
      providedAtOffset: this.#providedAtOffset,
    });
    return this.#revokePromise;
  }
}
