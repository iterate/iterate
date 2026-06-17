import { WorkerEntrypoint } from "cloudflare:workers";

export type IterateStreamAppendInput = {
  event: unknown;
  streamPath?: string;
};

export type IterateProjectStreams = {
  append(input: IterateStreamAppendInput): Promise<unknown>;
};

export type IterateProjectItx<Context = unknown> = {
  context: Promise<Context>;
};

export type IterateProjectEnv<Context = unknown> = {
  ITERATE: IterateProjectItx<Context>;
  STREAMS: IterateProjectStreams;
};

export type IterateProjectEventInput = {
  event: unknown;
  streamPath: string;
};

export declare class IterateProjectEntrypoint<Context = unknown> extends WorkerEntrypoint<
  IterateProjectEnv<Context>
> {
  get itx(): IterateProjectItx<Context>;
  get streams(): IterateProjectStreams;
  processEvent(input: IterateProjectEventInput): Promise<void>;
  protected onProjectEvent(input: IterateProjectEventInput): Promise<void>;
}
