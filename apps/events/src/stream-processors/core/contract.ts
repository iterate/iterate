import { z } from "zod";
import { CircuitBreakerConfig, ExternalSubscriber, StreamPath } from "@iterate-com/events-contract";
import { CoreProcessorContract } from "@iterate-com/shared/stream-processors/core/contract";
import { defineProcessorContract } from "@iterate-com/shared/stream-processors";

/**
 * Public contract for the stream durable object's own core events.
 *
 * This is the source of truth for the Events app docs. Do not add hand-written
 * event pages elsewhere; if a stream-owned event should be documented, add it
 * here. Non-core processors should live as their own processor contracts rather
 * than being smuggled into the core docs list.
 */
export const CoreStreamProcessorContract = defineProcessorContract({
  slug: "core",
  version: "0.1.0",
  description: "Stream durable object lifecycle, metadata, child-stream, and subscription events.",
  stateSchema: z.object({}).default({}),
  processorDeps: [],
  events: {
    ...CoreProcessorContract.events,
    "events.iterate.com/core/stream-initialized": {
      description: "The stream durable object was initialized for a project and path.",
      payloadSchema: z.object({
        projectSlug: z.string().trim().min(1).max(255),
        path: StreamPath,
      }),
    },
    "events.iterate.com/core/durable-object-woke-up": {
      description: "The stream durable object rehydrated persisted state after a cold start.",
      payloadSchema: z.object({}),
    },
    "events.iterate.com/core/child-stream-created": {
      description: "A child stream was implicitly created under this stream.",
      payloadSchema: z.object({
        childPath: StreamPath,
      }),
    },
    "events.iterate.com/core/metadata-updated": {
      description: "The stream metadata object was replaced.",
      payloadSchema: z.object({
        metadata: z.record(z.string(), z.unknown()),
      }),
    },
    "events.iterate.com/core/subscription-configured": {
      description: "A websocket or webhook subscriber was configured for this stream.",
      payloadSchema: ExternalSubscriber,
    },
    "events.iterate.com/core/circuit-breaker-configured": {
      description: "The stream circuit breaker configuration was replaced.",
      payloadSchema: CircuitBreakerConfig,
    },
    "events.iterate.com/core/paused": {
      description: "The stream stopped accepting ordinary appends.",
      payloadSchema: z.object({
        reason: z.string().trim().min(1).optional(),
      }),
    },
    "events.iterate.com/core/resumed": {
      description: "The stream resumed accepting ordinary appends.",
      payloadSchema: z.object({
        reason: z.string().trim().min(1).optional(),
      }),
    },
    "events.iterate.com/core/invalid-event-appended": {
      description: "An invalid append input was preserved as a core diagnostic event.",
      payloadSchema: z.object({
        rawInput: z.json(),
        error: z.string().trim().min(1),
      }),
    },
  },
  consumes: [],
  emits: [
    "events.iterate.com/core/stream-processor-registered",
    "events.iterate.com/core/error-occurred",
    "events.iterate.com/core/stream-initialized",
    "events.iterate.com/core/durable-object-woke-up",
    "events.iterate.com/core/child-stream-created",
    "events.iterate.com/core/metadata-updated",
    "events.iterate.com/core/subscription-configured",
    "events.iterate.com/core/circuit-breaker-configured",
    "events.iterate.com/core/paused",
    "events.iterate.com/core/resumed",
    "events.iterate.com/core/error-occurred",
    "events.iterate.com/core/invalid-event-appended",
  ],
});
