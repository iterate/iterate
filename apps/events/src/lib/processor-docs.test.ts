import { describe, expect, test } from "vitest";
import {
  getProcessorDocBySlug,
  getProcessorEventDoc,
  processorDocs,
} from "~/lib/processor-docs.ts";

describe("processor docs", () => {
  test("builds docs for agent event schemas", () => {
    const event = getProcessorEventDoc({
      processorSlug: "agent",
      eventSlug: "input-added",
    });

    expect(processorDocs.map((processor) => processor.contract.slug)).toContain("agent");
    expect(event?.payloadJsonSchema).toMatchObject({
      type: "object",
      properties: {
        content: { type: "string" },
      },
    });
  });

  test("resolves descriptions for agent consumed dependency events", () => {
    const processor = getProcessorDocBySlug("agent");

    expect(processor?.consumes).toContainEqual(
      expect.objectContaining({
        type: "events.iterate.com/core/stream-processor-registered",
        description: "A processor registered its public contract on this stream.",
      }),
    );
  });
});
