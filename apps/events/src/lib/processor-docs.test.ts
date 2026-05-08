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
        content: {
          type: "string",
          description: "Model-visible user context to append to agent history.",
        },
        triggerLlmRequest: {
          oneOf: [
            { title: "auto" },
            { title: "dont-trigger-request" },
            { title: "interrupt-current-request" },
            { title: "after-current-request" },
            { title: "trigger-request-within-time-period" },
          ],
        },
      },
      examples: [
        {
          content: "Summarize the deployment logs.",
        },
        {
          content: "Actually, focus only on failed checks.",
          triggerLlmRequest: { behaviour: "interrupt-current-request" },
        },
      ],
    });
    expect(event?.examples).toEqual([
      {
        description: "User input that uses the default automatic LLM request behaviour.",
        payload: {
          content: "Summarize the deployment logs.",
        },
      },
      {
        description: "User input that interrupts the current request before starting a new one.",
        payload: {
          content: "Actually, focus only on failed checks.",
          triggerLlmRequest: { behaviour: "interrupt-current-request" },
        },
      },
    ]);
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
