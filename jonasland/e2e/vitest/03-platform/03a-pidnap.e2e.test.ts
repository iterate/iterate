import { describe } from "vitest";
import { test } from "../../test-support/e2e-test.ts";

const cases = [
  {
    id: "docker" as const,
    tags: ["docker"] as const,
  },
  {
    id: "fly" as const,
    tags: ["fly", "slow"] as const,
  },
];

describe("pidnap", () => {
  describe.each(cases)("$id", ({ tags }) => {
    test.todo("managed processes become healthy", {
      tags: [...tags],
    });
    test.todo("process configuration changes are applied correctly", {
      tags: [...tags],
    });
    test.todo("restart behavior preserves the state we rely on", {
      tags: [...tags],
    });
    test.todo("container or machine restart preserves pidnap-managed expectations", {
      tags: [...tags],
    });
  });
});
