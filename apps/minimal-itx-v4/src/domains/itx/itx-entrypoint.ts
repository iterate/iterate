import { WorkerEntrypoint } from "cloudflare:workers";
import { trustedInternalAuthContext } from "../../auth.ts";
import type { Env } from "../../env.ts";
import { AgentItxRpcTarget, ProjectCollectionRpcTarget } from "../projects/rpc-targets.ts";
import type { Project } from "../projects/types.ts";
import { scopeFromItxEntrypointProps, type ItxEntrypointProps } from "./entrypoint-props.ts";
import type { AgentItx } from "./types.ts";

export class ItxEntrypoint extends WorkerEntrypoint<Env, ItxEntrypointProps> {
  async get(): Promise<AgentItx | Project> {
    const { path, projectId } = scopeFromItxEntrypointProps(this.ctx.props);
    const auth = trustedInternalAuthContext();
    if (path.startsWith("/agents/")) {
      return new AgentItxRpcTarget({
        agentPath: path,
        auth,
        ctx: this.ctx,
        projectId,
      });
    }

    const project = await new ProjectCollectionRpcTarget({
      auth,
      ctx: this.ctx,
    }).get(projectId);
    if (path === "/") return project;
    throw new Error(`env.ITX.get() only supports project root and agent paths, got "${path}"`);
  }
}
