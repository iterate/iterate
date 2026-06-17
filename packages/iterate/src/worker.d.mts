import { WorkerEntrypoint } from "cloudflare:workers";

export type IterateStreamAppendInput = {
  event: unknown;
  streamPath?: string;
};

export type IterateProjectStreams = {
  append(input: IterateStreamAppendInput): Promise<unknown>;
};

export type IterateProjectEnv = {
  ITERATE: unknown;
  STREAMS: IterateProjectStreams;
};

export type IterateProjectEventInput = {
  event: unknown;
  streamPath: string;
};

export declare class IterateProjectEntrypoint extends WorkerEntrypoint<IterateProjectEnv> {
  get itx(): IterateProjectEnv["ITERATE"];
  get streams(): IterateProjectStreams;
  processEvent(input: IterateProjectEventInput): Promise<void>;
  protected onProjectEvent(input: IterateProjectEventInput): Promise<void>;
}
