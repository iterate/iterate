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

describe("otel tracing", () => {
  describe.each(cases)("$id", ({ tags }) => {
    test.todo("service calls produce the traces we expect", {
      tags: [...tags],
    });
    test.todo("trace visibility works through the supported observability surface", {
      tags: [...tags],
    });
  });
});
