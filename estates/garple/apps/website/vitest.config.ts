import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Opus suggest this to address this issue: https://iterate-com.slack.com/archives/C06LU7PGK0S/p1751977574455339
    // There's a linear ticket to unerstand this better but not high priority _right now_
    // https://linear.app/iterate-com/issue/ITE-1747/understand-why-vitest-trpc-client-hangs-after-tests-when-not-using
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
