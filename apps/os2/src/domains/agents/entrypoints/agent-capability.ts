import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { ExecuteCodemodeFunctionCallInput } from "@iterate-com/shared/stream-processors/codemode/implementation";
import type { AgentDurableObject } from "../durable-objects/agent-durable-object.ts";

type AgentCapabilityEnv = {
  AGENT?: DurableObjectNamespace<AgentDurableObject>;
};

type AgentCapabilityProps = {
  projectId?: string;
};

export class AgentCapability extends WorkerEntrypoint<AgentCapabilityEnv, AgentCapabilityProps> {
  async executeCodemodeFunctionCall(input: ExecuteCodemodeFunctionCallInput) {
    if (input.functionPath.length !== 0) {
      throw new Error(
        `AgentCapability is unary and expected an empty functionPath, received ${input.functionPath.join(".")}`,
      );
    }
    if (!this.env.AGENT) {
      throw new Error("AGENT Durable Object namespace is not configured.");
    }

    return new AgentHandle(this.env.AGENT.getByName(requireProjectId(this.ctx.props)));
  }
}

class AgentHandle extends RpcTarget {
  readonly #agent: DurableObjectStub<AgentDurableObject>;

  constructor(agent: DurableObjectStub<AgentDurableObject>) {
    super();
    this.#agent = agent;
  }

  async sendMessage(input: { message: string; subPath?: string }) {
    return await this.#agent.sendMessage(input);
  }

  async doThing(input: { label: string; value: number }) {
    return await this.#agent.doThing(input);
  }
}

function requireProjectId(props: AgentCapabilityProps | undefined) {
  const projectId = props?.projectId;
  if (!projectId) throw new Error("AgentCapability requires ctx.props.projectId.");
  return projectId;
}
