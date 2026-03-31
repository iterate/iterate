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

describe("open observe", () => {
  describe.each(cases)("$id", ({ tags }) => {
    test.todo("open observe starts and is reachable", {
      tags: [...tags],
    });
    test.todo("open observe behaves correctly behind the intended ingress model", {
      tags: [...tags],
    });
  });
});
