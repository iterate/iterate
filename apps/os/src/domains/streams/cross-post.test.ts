import { describe, expect, it } from "vitest";
import { StreamEventInput, type StreamEvent } from "iterate/stream-events";
import { buildCrossPostAppendInput } from "./cross-post.ts";

describe("buildCrossPostAppendInput", () => {
  it("strips committed-only fields before forwarding through append", () => {
    const sourceEvent: StreamEvent = {
      type: "events.iterate.test/source",
      payload: { marker: "source" },
      metadata: { traceId: "trace_123" },
      source: {
        processor: {
          slug: "test-processor",
          version: "1.0.0",
          stream: { path: "/source", projectId: "prj_123" },
          whileProcessing: { offset: 7, type: "events.iterate.test/trigger" },
        },
      },
      idempotencyKey: "original",
      offset: 42,
      createdAt: "2026-07-08T12:00:00.000Z",
      path: "/source",
    };
    const hop = {
      subscriptionKey: "source-to-target",
      createdAt: sourceEvent.createdAt,
      offset: sourceEvent.offset,
      path: sourceEvent.path,
      projectId: "prj_123",
      type: sourceEvent.type,
    };

    const input = buildCrossPostAppendInput({
      event: sourceEvent,
      crossPostedFrom: [hop],
      idempotencyKey: "cross-post:source-to-target:prj_123:/source:42",
    });

    expect("createdAt" in input).toBe(false);
    expect("offset" in input).toBe(false);
    expect("path" in input).toBe(false);
    expect(input).toEqual({
      type: sourceEvent.type,
      payload: sourceEvent.payload,
      metadata: sourceEvent.metadata,
      source: {
        processor: sourceEvent.source?.processor,
        crossPostedFrom: [hop],
      },
      idempotencyKey: "cross-post:source-to-target:prj_123:/source:42",
    });
    expect(() => StreamEventInput.strict().parse(input)).not.toThrow();
  });
});
