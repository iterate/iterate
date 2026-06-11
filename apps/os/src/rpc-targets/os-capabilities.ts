import { WorkerEntrypoint } from "cloudflare:workers";

type ExampleCapabilityEnv = {
  AI?: {
    run(model: string, input: unknown): Promise<unknown>;
  };
};

type ExampleCapabilityProps = {
  projectId?: string;
};

export class AiCapability extends WorkerEntrypoint<ExampleCapabilityEnv, ExampleCapabilityProps> {
  async run(model: string, request: unknown) {
    if (this.env.AI) {
      return await this.env.AI.run(model, request);
    }

    return {
      model,
      response: `AI binding is not configured; received ${JSON.stringify(request)}`,
    };
  }
}
