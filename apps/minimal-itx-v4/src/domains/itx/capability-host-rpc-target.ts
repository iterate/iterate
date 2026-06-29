import { RpcTarget } from "cloudflare:workers";
import type { RpcTargetImplementation } from "../../rpc-target-types.ts";
import {
  type ItxProcessorRpc,
  type ProvideCapabilityInput,
} from "./itx-processor-implementation.ts";
import { isReservedDynamicPathSegment } from "./path-proxy.ts";
import type { ItxCapabilityHost } from "./types.ts";

export abstract class ItxCapabilityHostRpcTarget
  extends RpcTarget
  implements RpcTargetImplementation<ItxCapabilityHost>
{
  protected abstract itxProcessor(): ItxProcessorRpc;

  async provideCapability(input: ProvideCapabilityInput) {
    this.#rejectBuiltinCollision(input.path);
    await this.itxProcessor().provideCapability(input);
    return {
      revoke: () => {
        return this.revokeCapability({ path: input.path });
      },
    };
  }

  revokeCapability(input: { path: string[] }) {
    return this.itxProcessor().revokeCapability(input);
  }

  runScript(code: string) {
    return this.itxProcessor().runScript(code);
  }

  invokeCapability({ args = [], path }: { args?: unknown[]; path: string[] }) {
    return this.itxProcessor().invokeCapability({ args, path });
  }

  #rejectBuiltinCollision(path: string[]) {
    const root = path[0];
    if (!root) return;
    if (isReservedDynamicPathSegment(root)) {
      throw new Error(`cannot provide capability "${root}": it is a reserved ITX path segment`);
    }
    if (root in this) {
      throw new Error(`cannot provide capability "${root}": it is already on this ITX target`);
    }
  }
}
