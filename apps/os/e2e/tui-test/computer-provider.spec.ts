import { expect, test } from "@microsoft/tui-test";
import { SPEC_EXPECT_TIMEOUT_MS } from "@iterate-com/shared/test-support/e2e-policy";

// TUI Test 0.0.4 does not load config-level expect timeouts in its worker.
const started = { timeout: SPEC_EXPECT_TIMEOUT_MS };
// Mounting includes the provider's bounded 25s connect-and-provide operation.
// The 55s spec watchdog leaves another 10s to persist diagnostics and a trace.
const computerMountVisible = { timeout: 30_000 };

test("starts the existing computer provider from /use-my-computer", async ({ terminal }) => {
  await expect(terminal.getByText("live", { strict: false })).toBeVisible(started);

  terminal.submit("/use-my-computer");

  await expect(terminal.getByText("shared itx.", { strict: false })).toBeVisible(
    computerMountVisible,
  );
  const view = terminal.serialize().view;
  expect(view).not.toContain("you › /use-my-computer");
});
