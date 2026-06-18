import { env as workerEnv, RpcTarget } from "cloudflare:workers";
import { pathInvokerToProxy } from "../../itx/path-invoker.ts";
import { formatDurableObjectName } from "../durable-object-names.ts";

export class AgentsRpcTarget extends RpcTarget {
  #projectId: string;

  constructor(input: { projectId: string }) {
    super();
    this.#projectId = input.projectId;
  }

  get(agentPathInput: string) {
    const path = normalizeAgentPath(agentPathInput);
    const agent = workerEnv.AGENT.getByName(
      formatDurableObjectName({ projectId: this.#projectId, path }),
    );
    return pathInvokerToProxy(agent);
  }
}

function normalizeAgentPath(path: string): string {
  if (!path.startsWith("/agents/")) {
    throw new Error(`agent path must start with "/agents/", got "${path}"`);
  }
  return path;
}
