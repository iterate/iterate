import { expect, test } from "vitest";
import { ITX_EXAMPLES } from "../../itx/examples.ts";

test("agents can discover how to list, create, edit, and cancel mobile location reminders", () => {
  const example = ITX_EXAMPLES.find((candidate) => candidate.id === "mobile-location-reminder");
  expect(example).toMatchObject({
    description: expect.stringContaining("List before changing existing reminders"),
  });
  expect(example?.code).toContain("/mobile/location-reminders");
  expect(example?.code).toContain("events.iterate.com/location-reminder/requested");
  expect(example?.code).toContain("events.iterate.com/location-reminder/cancelled");
  expect(example?.code).toContain('vars.action === "list"');
  expect(example?.code).toContain("vars.operationId || crypto.randomUUID()");
});
