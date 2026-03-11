import { describe } from "vitest";
import { test } from "../../test-support/e2e-test.ts";

const cases = [
  {
    id: "docker" as const,
    tags: ["providers/docker"] as const,
  },
  {
    id: "fly" as const,
    tags: ["providers/fly", "slow"] as const,
  },
];

describe("events service", () => {
  describe.each(cases)("$id", ({ tags }) => {
    test.todo("events can be appended and later observed", {
      tags: [...tags],
    });
    test.todo("firehose subscribers receive appended events", {
      tags: [...tags],
    });
    test.todo("event workflows behave correctly across provider cases", {
      tags: [...tags],
    });
  });
});
