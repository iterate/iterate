import { describe } from "vitest";
import { test } from "../../test-support/e2e-test.ts";

/**
 * Legacy migration notes from deleted `jonasland/e2e/tests/clean/agent-cli.e2e.test.ts`.
 *
 * That file verified that the real agent CLIs in the sandbox image could answer
 * a simple arithmetic prompt when given real API keys. It was parameterized
 * across Docker and Fly and used the same basic recipe for each CLI:
 *
 * - create deployment with `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`
 * - `await deployment.waitUntilAlive(...)`
 * - invoke the CLI from a login shell so PATH and shell init match the image
 * - assert the output contains `42`
 *
 * Legacy command shapes worth keeping:
 *
 * - `opencode run 'what is 50 minus 8?'`
 * - `claude -p 'what is 50 minus 8?'`
 * - `pi -p 'what is 50 minus 8?'`
 * - `codex exec 'what is 50 minus 8?'`
 *
 * The old file explicitly skipped codex because the Responses API depends on
 * WebSocket traffic, and that path still broke through the caddy TLS MITM
 * egress layer. Keep that limitation documented until websocket egress is
 * proven green in the sandbox image.
 */
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
    // Start with the one-shot "answer a simple question" smoke checks from the
    // legacy suite before growing into richer prompt/replay coverage.
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
