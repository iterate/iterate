import { DurableObject } from "cloudflare:workers";

export class RepoDurableObject extends DurableObject {
  async proofOfConcept(input: { callback?: (args: unknown) => unknown; message?: string }) {
    const payload = {
      repoName: this.ctx.id.name,
      message: input.message ?? "repo proof of concept",
    };
    await input.callback?.(payload);
    return payload;
  }
}
