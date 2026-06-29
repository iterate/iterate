export interface Stream {
  append(...events: StreamEventInput[]): StreamEvent[];
  at(path: string): Stream;
  getEvent(
    input: { offset: number; idempotencyKey?: never } | { idempotencyKey: string; offset?: never },
  ): StreamEvent | undefined;
  getEvents(input?: {
    afterOffset?: number;
    beforeOffset?: number | null;
    limit?: number;
  }): StreamEvent[];
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
  runtimeState(): {
    coreProcessorState: unknown;
    runtime: {
      connections: Record<string, unknown>;
    };
  };
  kill(): void;
  subscribe(input: {
    subscriptionKey?: string;
    processEventBatch: (batch: {
      projectId: string | null;
      path: string;
      events: StreamEvent[];
      streamMaxOffset: number;
      state: unknown;
    }) => unknown;
    replayAfterOffset?: number;
    eventTypes?: readonly string[];
    events?: boolean;
    subscriber?: unknown;
  }): {
    subscriptionKey: string;
    streamMaxOffset: number;
    unsubscribe(): void;
  };
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
