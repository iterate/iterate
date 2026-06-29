export interface Stream {
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
  at(path: string): Stream;
  getEvent(
    input: { offset: number; idempotencyKey?: never } | { idempotencyKey: string; offset?: never },
  ): Promise<StreamEvent | undefined>;
  getEvents(input?: {
    afterOffset?: number;
    beforeOffset?: number | null;
    limit?: number;
  }): Promise<StreamEvent[]>;
  waitForEvent(input: {
    afterOffset?: number;
    eventTypes?: readonly string[];
    predicate?: (event: StreamEvent) => boolean | Promise<boolean>;
    timeoutMs: number;
  }): Promise<StreamEvent>;
  getProcessorRuntimeState(input: { subscriptionKey: string }): Promise<{
    snapshot: {
      offset: number;
      state: unknown;
    };
    runtime?: Record<string, unknown>;
  } | null>;
  runtimeState(): Promise<{
    coreProcessorState: unknown;
    runtime: {
      connections: Record<string, unknown>;
    };
  }>;
  subscribe(input: {
    subscriptionKey?: string;
    processEventBatch: ProcessEventBatch;
    replayAfterOffset?: number;
    eventTypes?: readonly string[];
    events?: boolean;
    subscriber?: unknown;
  }): Promise<StreamSubscriptionHandle>;
}

export interface StreamCollection {
  get(path: string): Stream;
}

export type StreamEventInput = {
  type: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  source?: {
    processor?: {
      slug: string;
      version: string;
    };
  };
  idempotencyKey?: string;
};

export type StreamEvent = StreamEventInput & {
  createdAt: string;
  offset: number;
};

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

export type GetProcessorRuntimeState = () => ProcessorRuntimeState | Promise<ProcessorRuntimeState>;

export type StreamSubscriptionHandle = {
  subscriptionKey: SubscriptionKey;
  streamMaxOffset: number;
  unsubscribe(): void;
};
