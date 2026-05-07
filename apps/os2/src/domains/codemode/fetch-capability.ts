import { WorkerEntrypoint } from "cloudflare:workers";
import type { ExecuteCodemodeFunctionCallInput } from "@iterate-com/shared/stream-processors/codemode/implementation";

type FetchCapabilityProps = {
  projectId: string;
};

export class FetchCapability extends WorkerEntrypoint<
  Record<string, unknown>,
  FetchCapabilityProps
> {
  async executeCodemodeFunctionCall(input: ExecuteCodemodeFunctionCallInput) {
    if (input.functionPath.length !== 0) {
      throw new Error(
        `FetchCapability is unary and expected an empty functionPath, received ${input.functionPath.join(".")}`,
      );
    }

    const [requestInfo, requestInit] = input.args as [RequestInfo | URL, RequestInit | undefined];
    // Public egress is deliberately behind a codemode provider instead of the
    // Dynamic Worker's ambient global fetch. That keeps fetch traceable in the
    // Function Call event log and leaves room for project egress policy here.
    return await fetch(requestInfo, requestInit);
  }
}
