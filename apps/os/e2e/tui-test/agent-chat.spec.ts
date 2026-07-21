import { expect, test } from "@microsoft/tui-test";
import { SPEC_EXPECT_TIMEOUT_MS } from "@iterate-com/shared/test-support/e2e-policy";

// TUI Test 0.0.4 does not load config-level expect timeouts in its worker.
const visible = { timeout: SPEC_EXPECT_TIMEOUT_MS };
const started = { timeout: SPEC_EXPECT_TIMEOUT_MS };
const visibleAgentPath = "/agents/tui-test";
const projectId = process.env.OS_E2E_TUI_PROJECT_ID!;

test("Agent chat TUI connects, renders the feed, and sends", async ({ terminal }) => {
  // Wait for a UI-only marker first. The PTY echoes the launch command before
  // OpenTUI enters alternate-screen mode, and that command contains agentPath.
  await expect(terminal.getByText("Message the agent", { strict: false })).toBeVisible(started);
  // Every attempt owns a fresh project, so the stable path can stay short
  // enough that the header's connection state remains visible too.
  await expect(terminal.getByText(visibleAgentPath, { strict: false })).toBeVisible(visible);

  // The live subscription round trip completes (capnweb websocket + subscribe).
  await expect(terminal.getByText("live", { strict: false })).toBeVisible(visible);

  // The feed renders from the reduced model, not raw events: a fresh agent
  // stream's first fold produces the wake marker item.
  await expect(terminal.getByText("Stream durable object woke", { strict: false })).toBeVisible(
    visible,
  );

  // The message must come back through the server subscription and shared
  // reducer before it can render as a settled feed item.
  terminal.write("hello from microsoft tui test");
  terminal.submit();

  await expect(terminal.getByText("you ›", { strict: false })).toBeVisible(visible);
  await expect(terminal.getByText("hello from microsoft tui test", { strict: false })).toBeVisible(
    visible,
  );
  await expect(terminal.getByText("Message the agent", { strict: false })).toBeVisible(visible);

  const view = terminal.serialize().view;
  expect(view).toContain(visibleAgentPath);
  expect(view).toContain(projectId);
  expect(view).toContain("●");
  expect(view).toContain("Message the agent");
  expect(view).not.toContain("raw event");
});
