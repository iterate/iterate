import { WorkerEntrypoint } from "cloudflare:workers";

export type IterateStreamAppendInput = {
  event: unknown;
  streamPath?: string;
};

export type IterateProjectStreams = {
  append: (input: IterateStreamAppendInput) => Promise<unknown>;
};

export type IterateProjectEnv = {
  ITERATE: unknown;
  STREAMS: IterateProjectStreams;
};

export type IterateProjectEventInput = {
  event: unknown;
  streamPath: string;
};

export class IterateProjectEntrypoint extends WorkerEntrypoint<IterateProjectEnv> {
  get itx(): IterateProjectEnv["ITERATE"] {
    return this.env.ITERATE;
  }

  get streams(): IterateProjectEnv["STREAMS"] {
    return this.env.STREAMS;
  }

  async processEvent(input: IterateProjectEventInput): Promise<void> {
    await this.onProjectEvent(input);
  }

  protected async onProjectEvent(_input: IterateProjectEventInput): Promise<void> {}
}
