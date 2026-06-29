import { WorkerEntrypoint } from "cloudflare:workers";
import { trustedInternalAuthContext } from "../../auth.ts";
import type { Env } from "../../env.ts";
import { ProjectCollectionRpcTarget } from "../projects/rpc-targets.ts";
import { scopeFromItxEntrypointProps, type ItxEntrypointProps } from "./entrypoint-props.ts";
import type { ScopedItx } from "./types.ts";

export class ItxEntrypoint extends WorkerEntrypoint<Env, ItxEntrypointProps> {
  async get(): Promise<ScopedItx> {
    const { path, projectId } = scopeFromItxEntrypointProps(this.ctx.props);
    const project = await new ProjectCollectionRpcTarget({
      auth: trustedInternalAuthContext(),
      ctx: this.ctx,
    }).get(projectId);
    if (path === "/") return project;
    if (path.startsWith("/agents/")) return await project.agents.get(path);
    throw new Error(`env.ITX.get() only supports project root and agent paths, got "${path}"`);
  }
}
