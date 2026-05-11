import { DurableObject } from "cloudflare:workers";
import type { ExecuteCodemodeFunctionCallInput } from "@iterate-com/shared/stream-processors/codemode/implementation";

export class WorkspaceDurableObject extends DurableObject {
  async executeCodemodeFunctionCall(input: ExecuteCodemodeFunctionCallInput) {
    if (input.functionPath.join(".") !== "proofOfConcept") {
      throw new Error(`WorkspaceDurableObject does not implement ${input.functionPath.join(".")}`);
    }

    const [request] = input.args as [{ callback?: (args: unknown) => unknown; message?: string }];
    const payload = {
      workspaceName: this.ctx.id.name,
      message: request?.message ?? "workspace proof of concept",
    };
    await request?.callback?.(payload);
    return payload;
  }
}
