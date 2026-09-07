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
  /**
   * Offset, on the same stream, of the event this one was derived from.
   * Derived render facts point at their raw input; the reducer shows derived
   * facts and falls back to the raw event only when nothing sources it.
   */
  offset?: number;
};

export type StreamEvent<Type extends string = string, Payload = unknown> = {
  type: Type;
  payload?: Payload;
  metadata?: Record<string, unknown>;
  source?: StreamEventSource;
  idempotencyKey?: string;
  /** Memory-only live-window event (never durably delivered or persisted);
   * absent means durable. */
  ephemeral?: true;
  offset: number;
  createdAt: string;
};
