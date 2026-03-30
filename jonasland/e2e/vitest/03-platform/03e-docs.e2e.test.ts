import { describe } from "vitest";
import { test } from "../../test-support/e2e-test.ts";

const cases = [
  {
    id: "docker" as const,
    tags: ["docker", "no-internet"] as const,
  },
  {
    id: "fly" as const,
    tags: ["fly", "slow"] as const,
  },
];

describe("docs service", () => {
  describe.each(cases)("$id", ({ tags }) => {
    test.todo("docs service starts and is reachable through the documented paths", {
      tags: [...tags],
    });
    test.todo("docs service works in the intended provider and connectivity modes", {
      tags: [...tags],
    });
  });
});
