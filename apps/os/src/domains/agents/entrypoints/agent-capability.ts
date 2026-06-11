import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { getInitializedDoStub } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { StreamPath } from "@iterate-com/shared/streams/types";
import {
  type AgentDurableObject,
  getAgentDurableObjectName,
} from "../durable-objects/agent-durable-object.ts";
import { replayPathCall } from "~/itx/path-proxy.ts";
import type { PathCall } from "~/itx/protocol.ts";

type AgentCapabilityEnv = {
  AGENT?: DurableObjectNamespace<AgentDurableObject>;
};

type AgentCapabilityProps = {
  projectId?: string;
};

type AgentRpcStub = {
  doThing(input: { label: string; value: number }): Promise<unknown>;
  getRuntimeState(): Promise<unknown>;
  sendMessage(input: { channel?: string; message: string }): Promise<unknown>;
};

export class AgentCapability extends WorkerEntrypoint<AgentCapabilityEnv, AgentCapabilityProps> {
  /** The itx kernel's one calling convention; replay walks this entrypoint's own members. */
  call(input: PathCall): Promise<unknown> {
    return replayPathCall(this, input);
  }

  create() {
    if (!this.env.AGENT) {
      throw new Error("AGENT Durable Object namespace is not configured.");
    }

    return new AgentHandle({
      namespace: this.env.AGENT,
      projectId: requireProjectId(this.ctx.props),
    });
  }
}

class AgentHandle extends RpcTarget {
  readonly #namespace: DurableObjectNamespace<AgentDurableObject>;
  readonly #projectId: string;

  constructor(input: { namespace: DurableObjectNamespace<AgentDurableObject>; projectId: string }) {
    super();
    this.#namespace = input.namespace;
    this.#projectId = input.projectId;
  }

  async sendMessage(input: {
    agentPath?: string;
    channel?: string;
    message: string;
    subPath?: string;
  }) {
    await (
      await this.getAgent(input.agentPath ?? agentPathFromSubPath(input.subPath))
    ).sendMessage({
      channel: input.channel,
      message: input.message,
    });
    return {
      message: input.message,
      ...(input.subPath == null ? {} : { subPath: input.subPath }),
    };
  }

  async doThing(input: { agentPath?: string; label: string; value: number }) {
    return await (await this.getAgent(input.agentPath ?? "/agents/default")).doThing(input);
  }

  async getRuntimeState(input: { agentPath?: string } = {}) {
    return await (await this.getAgent(input.agentPath ?? "/agents/default")).getRuntimeState();
  }

  private async getAgent(agentPathInput: string): Promise<AgentRpcStub> {
    const name = {
      agentPath: StreamPath.parse(agentPathInput),
      projectId: this.#projectId,
    };
    return (await getInitializedDoStub({
      allowCreate: true,
      namespace: this.#namespace,
      name: getAgentDurableObjectName(name),
    })) as unknown as AgentRpcStub;
  }
}

function agentPathFromSubPath(subPath: string | undefined) {
  if (subPath == null || subPath.trim() === "") return "/agents/default";
  if (subPath.startsWith("/")) return subPath;
  return `/agents/${subPath}`;
}

function requireProjectId(props: AgentCapabilityProps | undefined) {
  const projectId = props?.projectId;
  if (!projectId) throw new Error("AgentCapability requires ctx.props.projectId.");
  return projectId;
}
