import { expect, test } from "@microsoft/tui-test";
import { SPEC_EXPECT_TIMEOUT_MS } from "@iterate-com/shared/test-support/e2e-policy";

const visible = { timeout: SPEC_EXPECT_TIMEOUT_MS };
const visibleAgentPath = "/agents/tui-test";

test("captures a manual aesthetic snapshot", async ({ terminal }) => {
  await expect(terminal.getByText("Message the agent", { strict: false })).toBeVisible(visible);
  await expect(terminal.getByText(visibleAgentPath, { strict: false })).toBeVisible(visible);

  terminal.submit("snapshot review message");

  await expect(terminal.getByText("snapshot review message", { strict: false })).toBeVisible(
    visible,
  );
  await expect(terminal).toMatchSnapshot({ includeColors: true });
});
