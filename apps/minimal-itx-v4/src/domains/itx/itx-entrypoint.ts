import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import type { RpcTargetImplementation } from "../../rpc-target-types.ts";
import { UnauthenticatedItxRpcTarget } from "./rpc-targets.ts";
import type { ItxAuthCredentials, UnauthenticatedItx } from "./types.ts";

export class ItxEntrypoint
  extends WorkerEntrypoint<Env, ItxAuthCredentials>
  implements Pick<RpcTargetImplementation<UnauthenticatedItx>, "authenticate">
{
  authenticate(input: ItxAuthCredentials = this.ctx.props) {
    return new UnauthenticatedItxRpcTarget(new Headers(), this.ctx).authenticate(input);
  }
}
