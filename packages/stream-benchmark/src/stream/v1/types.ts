export type StreamOffset = number;
export type StreamTimestamp = string; // ISO timestamp
export type StreamPath = `/${string}`;

export type StreamEventInput = {
  type: string;
  payload?: unknown;
  metadata?: Record<string, unknown>;
  source?: StreamEventSource;
  idempotencyKey?: string;
  offset?: StreamOffset; // optional precondition: must equal the next offset
};

export type StreamEventSource = {
  processor?: {
    slug: string;
    version: string;
  };
  tracing?: {
    cfRayId?: string;
    cfRequestId?: string;
  };
};

export type StreamEvent = {
  streamPath: StreamPath;
  offset: StreamOffset;
  createdAt: StreamTimestamp;
  type: string;
  payload?: unknown;
  metadata?: Record<string, unknown>;
  source?: StreamEventSource;
  idempotencyKey?: string;
};

export type StreamCursor = "start" | "end" | StreamOffset;

export type StreamSocketClientFrame =
  | {
      op: "append";
      event: StreamEventInput;
    }
  | {
      op: "appendBatch";
      events: StreamEventInput[];
    };

export type StreamSocketServerFrame =
  | {
      type: "ready";
      streamPath: StreamPath;
      after: StreamOffset;
      cfRay?: string;
    }
  | {
      type: "event";
      event: StreamEvent;
    }
  | {
      type: "error";
      message: string;
    };

/** Frames the stream sends to a StreamProcessor over an outbound WebSocket. */
export type ProcessorPushFrame =
  | {
      type: "ready";
      streamPath: StreamPath;
      after: StreamOffset;
      subscriberKey: string;
    }
  | {
      type: "event";
      event: StreamEvent;
    }
  | {
      type: "error";
      message: string;
    };

/** Frames a StreamProcessor may send back to the stream. */
export type ProcessorReplyFrame =
  | {
      op: "append";
      event: StreamEventInput;
    }
  | {
      op: "cursor";
      offset: StreamOffset;
    };
