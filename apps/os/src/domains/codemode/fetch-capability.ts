import { WorkerEntrypoint } from "cloudflare:workers";
import type { ExecuteCodemodeFunctionCallInput } from "~/domains/codemode/stream-processors/codemode/implementation.ts";
import {
  getProjectDurableObjectName,
  type ProjectDurableObject,
} from "~/domains/projects/durable-objects/project-durable-object.ts";

type FetchCapabilityProps = {
  projectId: string;
};

type FetchCapabilityEnv = {
  PROJECT?: DurableObjectNamespace<ProjectDurableObject>;
};

export class FetchCapability extends WorkerEntrypoint<FetchCapabilityEnv, FetchCapabilityProps> {
  async executeCodemodeFunctionCall(input: ExecuteCodemodeFunctionCallInput) {
    if (input.functionPath.length !== 0) {
      throw new Error(
        `FetchCapability is unary and expected an empty functionPath, received ${input.functionPath.join(".")}`,
      );
    }

    const [requestInfo, requestInit] = input.args as [RequestInfo | URL, RequestInit | undefined];
    return await this.fetch(requestInfo, requestInit);
  }

  async fetch(requestInfo: RequestInfo | URL, requestInit?: RequestInit) {
    // Public egress is deliberately behind a codemode provider instead of the
    // Dynamic Worker's ambient global fetch. That keeps fetch traceable in the
    // Function Call event log while using the same Project Durable Object egress
    // policy as project config workers.
    if (!this.env.PROJECT) {
      throw new Error("FetchCapability requires PROJECT binding for egress fetch.");
    }

    return await this.env.PROJECT.getByName(
      getProjectDurableObjectName(this.ctx.props.projectId),
    ).egressFetch(new Request(requestInfo, requestInit));
  }
}
