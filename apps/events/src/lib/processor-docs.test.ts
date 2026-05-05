import { describe, expect, test } from "vitest";
import { getProcessorEventDocByType, processorDocs } from "./processor-docs.ts";

describe("processorDocs", () => {
  test("builds docs for schemas with compatibility transforms", () => {
    const subscriptionConfigured = getProcessorEventDocByType(
      "events.iterate.com/core/subscription-configured",
    );

    expect(processorDocs.length).toBeGreaterThan(0);
    expect(subscriptionConfigured?.payloadJsonSchema).toMatchObject({
      anyOf: expect.any(Array),
    });
  });
});
