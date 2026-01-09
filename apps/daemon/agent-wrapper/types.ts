/**
 * Event types for the agent wrapper architecture.
 *
 * Events follow the Iterate envelope format with verbatim harness payloads.
 * See src/architecture-sketch.md for the full design.
 */
import { Schema } from "effect";
import { EventStreamId } from "../durable-streams/types.ts";

// Re-export for convenience
export { EventStreamId } from "../durable-streams/types.ts";

/**
 * Base envelope for all Iterate events.
 *
 * Protocol fields (offset) are assigned by durable-streams.
 * Envelope fields are always present. Type-specific payload varies.
 */
export class IterateEventEnvelope extends Schema.Class<IterateEventEnvelope>(
  "IterateEventEnvelope",
)({
  type: Schema.String,
  version: Schema.Number,
  createdAt: Schema.String,
  eventStreamId: EventStreamId,
  payload: Schema.optional(Schema.Unknown),
  metadata: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
}) {}

// Event type constants
export const PiEventTypes = {
  // Action events (requesting side effects)
  SESSION_CREATE: "iterate:agent:harness:pi:action:session-create:called",
  PROMPT: "iterate:agent:harness:pi:action:prompt:called",
  ABORT: "iterate:agent:harness:pi:action:abort:called",

  // Wrapped harness events (verbatim payload)
  EVENT_RECEIVED: "iterate:agent:harness:pi:event-received",
} as const;

// Generic action event for sending user messages (harness-agnostic)
export const AgentActionTypes = {
  SEND_USER_MESSAGE: "iterate:agent:action:send-user-message:called",
} as const;

/**
 * Payload schemas for action events
 */
export class SessionCreatePayload extends Schema.Class<SessionCreatePayload>(
  "SessionCreatePayload",
)({
  cwd: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  thinkingLevel: Schema.optional(Schema.String),
  sessionFile: Schema.optional(Schema.String),
}) {}

export class PromptPayload extends Schema.Class<PromptPayload>("PromptPayload")({
  content: Schema.String,
}) {}

export class AbortPayload extends Schema.Class<AbortPayload>("AbortPayload")({}) {}

/**
 * Wrapped Pi SDK event payload.
 * The `piEventType` field captures the original Pi event type.
 * The `piEvent` field contains the verbatim Pi SDK event.
 */
export class PiEventReceivedPayload extends Schema.Class<PiEventReceivedPayload>(
  "PiEventReceivedPayload",
)({
  piEventType: Schema.String,
  piEvent: Schema.Unknown,
}) {}

/**
 * Typed action events
 */
export class SessionCreateEvent extends Schema.Class<SessionCreateEvent>("SessionCreateEvent")({
  type: Schema.Literal(PiEventTypes.SESSION_CREATE),
  version: Schema.Number,
  createdAt: Schema.String,
  eventStreamId: EventStreamId,
  payload: SessionCreatePayload,
  metadata: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
}) {}

export class PromptEvent extends Schema.Class<PromptEvent>("PromptEvent")({
  type: Schema.Literal(PiEventTypes.PROMPT),
  version: Schema.Number,
  createdAt: Schema.String,
  eventStreamId: EventStreamId,
  payload: PromptPayload,
  metadata: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
}) {}

export class AbortEvent extends Schema.Class<AbortEvent>("AbortEvent")({
  type: Schema.Literal(PiEventTypes.ABORT),
  version: Schema.Number,
  createdAt: Schema.String,
  eventStreamId: EventStreamId,
  payload: AbortPayload,
  metadata: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
}) {}

export class PiEventReceivedEvent extends Schema.Class<PiEventReceivedEvent>(
  "PiEventReceivedEvent",
)({
  type: Schema.Literal(PiEventTypes.EVENT_RECEIVED),
  version: Schema.Number,
  createdAt: Schema.String,
  eventStreamId: EventStreamId,
  payload: PiEventReceivedPayload,
  metadata: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
}) {}

/**
 * Union of all Pi-related events
 */
export const PiIterateEvent = Schema.Union(
  SessionCreateEvent,
  PromptEvent,
  AbortEvent,
  PiEventReceivedEvent,
);
export type PiIterateEvent = typeof PiIterateEvent.Type;

/**
 * Helper to create events with current timestamp
 */
export const makeIterateEvent = <T extends { type: string }>(
  eventStreamId: EventStreamId,
  type: T["type"],
  payload?: unknown,
  metadata?: Record<string, unknown>,
): IterateEventEnvelope =>
  new IterateEventEnvelope({
    type,
    version: 1,
    createdAt: new Date().toISOString(),
    eventStreamId,
    payload,
    metadata,
  });

/**
 * Helper to create a session create event
 */
export const makeSessionCreateEvent = (
  eventStreamId: EventStreamId,
  options?: { cwd?: string; model?: string; thinkingLevel?: string; sessionFile?: string },
): SessionCreateEvent => {
  // Build payload without undefined values (Schema.optional doesn't accept undefined)
  const payloadFields: {
    cwd?: string;
    model?: string;
    thinkingLevel?: string;
    sessionFile?: string;
  } = {};
  if (options?.cwd !== undefined) payloadFields.cwd = options.cwd;
  if (options?.model !== undefined) payloadFields.model = options.model;
  if (options?.thinkingLevel !== undefined) payloadFields.thinkingLevel = options.thinkingLevel;
  if (options?.sessionFile !== undefined) payloadFields.sessionFile = options.sessionFile;

  return new SessionCreateEvent({
    type: PiEventTypes.SESSION_CREATE,
    version: 1,
    createdAt: new Date().toISOString(),
    eventStreamId,
    payload: new SessionCreatePayload(payloadFields),
  });
};

/**
 * Helper to create a prompt event
 */
export const makePromptEvent = (eventStreamId: EventStreamId, content: string): PromptEvent =>
  new PromptEvent({
    type: PiEventTypes.PROMPT,
    version: 1,
    createdAt: new Date().toISOString(),
    eventStreamId,
    payload: new PromptPayload({ content }),
  });

/**
 * Helper to create an abort event
 */
export const makeAbortEvent = (eventStreamId: EventStreamId): AbortEvent =>
  new AbortEvent({
    type: PiEventTypes.ABORT,
    version: 1,
    createdAt: new Date().toISOString(),
    eventStreamId,
    payload: new AbortPayload({}),
  });

/**
 * Helper to wrap a Pi SDK event
 */
export const makePiEventReceivedEvent = (
  eventStreamId: EventStreamId,
  piEventType: string,
  piEvent: unknown,
): PiEventReceivedEvent =>
  new PiEventReceivedEvent({
    type: PiEventTypes.EVENT_RECEIVED,
    version: 1,
    createdAt: new Date().toISOString(),
    eventStreamId,
    payload: new PiEventReceivedPayload({ piEventType, piEvent }),
  });
