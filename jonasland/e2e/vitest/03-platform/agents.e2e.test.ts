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

describe("agents", () => {
  describe.each(cases)("$id", ({ tags }) => {
    test.todo("claude responds in supported provider cases", {
      tags: [...tags],
    });
    test.todo("pi responds in supported provider cases", {
      tags: [...tags],
    });
    test.todo("opencode responds in supported provider cases", {
      tags: [...tags],
    });
    test.todo("codex responds in supported provider cases", {
      tags: [...tags],
    });
    test.todo(
      "agent coverage works both with live egress and with HAR-backed replay where feasible",
      {
        tags: [...tags],
      },
    );
  });
});
