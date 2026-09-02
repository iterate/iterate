/**
 * Minimal committed stream event shape consumed by the events components.
 *
 * This is a plain structural type — the itx event envelope
 * (`{ type, payload?, metadata?, offset, createdAt }`) is a superset of it.
 * Validation happens at the transport layer, not in the view reducer.
 */
export type StreamEventSource = {
  processor?: {
    slug: string;
    version: string;
  };
  /** Host-stamped script provenance: which script run wrote this event.
   * Trusted — StreamRpcTarget.append strips caller-supplied values before
   * commit — so the agent-ui fold may attribute events to exact code steps
   * by executionId. */
  script?: {
    executionId: string;
    streamPath: string;
    scriptRunRequestedEventOffset: number;
  };
};

export type StreamEvent<Type extends string = string, Payload = unknown> = {
  type: Type;
  payload?: Payload;
  metadata?: Record<string, unknown>;
  source?: StreamEventSource;
  idempotencyKey?: string;
  offset: number;
  createdAt: string;
};
