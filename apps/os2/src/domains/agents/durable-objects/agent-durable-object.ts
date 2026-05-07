import { DurableObject } from "cloudflare:workers";

export class AgentDurableObject extends DurableObject {
  async sendMessage(input: { message: string; subPath?: string }) {
    return {
      agentName: this.ctx.id.name,
      message: input.message,
      subPath: input.subPath ?? "default",
    };
  }

  async doThing(input: { label: string; value: number }) {
    return {
      agentName: this.ctx.id.name,
      label: input.label,
      value: input.value,
      doubled: input.value * 2,
    };
  }
}
