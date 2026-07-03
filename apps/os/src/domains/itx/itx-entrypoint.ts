import { WorkerEntrypoint } from "cloudflare:workers";
import { trustedInternalAuthContext } from "../../auth.ts";
import type { Env } from "../../env.ts";
import { CapabilityHostRpcTarget, ProjectRpcTarget } from "../../rpc-targets.ts";
import type { Itx } from "../../types.ts";
import { scopeFromItxEntrypointProps, type ItxEntrypointProps } from "./utils.ts";

/**
 * `env.ITX.get()` for a dynamic worker. It returns the itx for whatever scope the
 * host minted into this binding's props — the project root (`/`) for a project
 * worker, or an agent scope (`/agents/…`) for an agent script.
 *
 * There is deliberately no branching on the path: an agent context is not a
 * different type, it is the same {@link ProjectRpcTarget} fronting a deeper
 * scope's capability host. The agent's own `agent`/`chat` surface and the
 * capabilities of enclosing scopes come from the itx itself (getters + the
 * capability-host scope chain), not from a special entrypoint class.
 */
export class ItxEntrypoint extends WorkerEntrypoint<Env, ItxEntrypointProps> {
  async get(): Promise<Itx> {
    const { path, projectId } = scopeFromItxEntrypointProps(this.ctx.props);
    const auth = trustedInternalAuthContext();
    return new ProjectRpcTarget({
      auth,
      capabilityHost: new CapabilityHostRpcTarget({ auth, ctx: this.ctx, path, projectId }),
      ctx: this.ctx,
      projectId,
    });
  }
}
