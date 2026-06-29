import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import {
  authCredentialsFromItxEntrypointProps,
  scopeFromItxEntrypointProps,
  TRUSTED_INTERNAL_ITX_PROPS,
  type ItxEntrypointProps,
} from "./entrypoint-props.ts";
import { UnauthenticatedItxRpcTarget } from "./rpc-targets.ts";
import type { ItxAuthCredentials, ScopedItx, UnauthenticatedItx } from "./types.ts";

export class ItxEntrypoint
  extends WorkerEntrypoint<Env, ItxEntrypointProps>
  implements Pick<UnauthenticatedItx, "authenticate">
{
  authenticate(input: ItxAuthCredentials = authCredentialsFromItxEntrypointProps(this.ctx.props)) {
    return new UnauthenticatedItxRpcTarget(new Headers(), this.ctx).authenticate(input);
  }

  async get(): Promise<ScopedItx> {
    const { path, projectId } = scopeFromItxEntrypointProps(this.ctx.props);
    const root = this.authenticate(TRUSTED_INTERNAL_ITX_PROPS);
    const project = await root.projects.get(projectId);
    if (path === "/") return project;
    if (path.startsWith("/agents/")) return await project.agents.get(path);
    throw new Error(`env.ITX.get() only supports project root and agent paths, got "${path}"`);
  }
}
