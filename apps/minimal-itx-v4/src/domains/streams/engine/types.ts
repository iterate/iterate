import type { StreamEvent } from "../types.ts";

type MaybePromise<T> = T | Promise<T>;

export type SubscriptionKey = string;

export type StreamEventBatch = {
  projectId: string | null;
  path: string;
  events: StreamEvent[];
  streamMaxOffset: number;
  state: unknown;
};

export type ProcessEventBatch = (batch: StreamEventBatch) => unknown;

export type ProcessorRuntimeState = {
  snapshot: { offset: number; state: unknown };
  runtime?: Record<string, unknown>;
};

export type GetProcessorRuntimeState = () => MaybePromise<ProcessorRuntimeState>;

export type StreamSubscriptionHandle = {
  subscriptionKey: SubscriptionKey;
  streamMaxOffset: number;
  unsubscribe(): void;
};
