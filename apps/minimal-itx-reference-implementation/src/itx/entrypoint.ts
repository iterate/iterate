import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { formatDurableObjectName } from "../domains/durable-object-names.ts";
import type { Itx } from "./processor.ts";
import { pathInvokerToProxy } from "./path-invoker.ts";

export class ItxEntrypoint extends WorkerEntrypoint<Env, { projectId: string; path: string }> {
  async get(): Promise<Itx> {
    const { projectId, path: contextPath } = this.ctx.props;
    if (contextPath === "/") {
      const project = this.env.PROJECT.getByName(
        formatDurableObjectName({ projectId, path: contextPath }),
      );
      // Dynamic workers receive env.ITX as a named Worker entrypoint. Calling
      // env.ITX.get() returns the same dotted ITX handle the browser gets:
      // every property path is collapsed into one invokeCapability call on the
      // owning Project Durable Object.
      return pathInvokerToProxy(project) as Itx;
    }
    // This is a slightly janky way of working out which host durable object namespace to use
    // Could also alternatively pass in the durable object namespace or class to use
    if (contextPath.startsWith("/agents/")) {
      const agent = this.env.AGENT.getByName(
        formatDurableObjectName({ projectId, path: contextPath }),
      );
      // Same handle shape for agent-scoped dynamic workers; only the owning
      // Durable Object binding changes.
      return pathInvokerToProxy(agent) as Itx;
    }
    throw new Error(
      `no ITX host for path "${contextPath}" (only "/" and "/agents/..." are host-owned contexts)`,
    );
  }
}
