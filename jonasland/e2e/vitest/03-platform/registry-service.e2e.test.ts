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

describe("registry service", () => {
  describe.each(cases)("$id", ({ tags }) => {
    test.todo("service routes become visible to the registry", {
      tags: [...tags],
    });
    test.todo("public URL resolution matches the configured ingress rules", {
      tags: [...tags],
    });
    test.todo("registry changes cause caddy routing to converge correctly", {
      tags: [...tags],
    });
  });
});
