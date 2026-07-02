import { expect, test } from "@microsoft/tui-test";

// A fresh agent path per run: the project processor configures the agent
// subscription on first append, so any /agents/* path is chattable.
const agentPath = `/agents/tui-test-${Date.now()}`;
const agentName = agentPath.slice("/agents/".length);
const projectId = process.env.OS_E2E_TUI_PROJECT_ID || "missing-os-tui-project";
const testWithProject = process.env.OS_E2E_TUI_PROJECT_ID ? test : test.skip;
const snapshotTest =
  process.env.OS_E2E_TUI_PROJECT_ID && process.env.OS_E2E_TUI_SNAPSHOT === "1" ? test : test.skip;

test.use({
  columns: 100,
  rows: 32,
  // TUI Test owns only the terminal harness. The app still starts through the
  // same `pnpm iterate chat` path a user runs from the repo. The OS base URL
  // comes from the config file that run.ts writes (via XDG_CONFIG_HOME), and
  // auth comes from the admin secret in the inherited doppler environment.
  // Primary API reference: https://github.com/microsoft/tui-test#terminal-program
  program: {
    file: "pnpm",
    args: ["-w", "iterate", "chat", "--project", projectId, "--agent-path", agentPath],
  },
});

testWithProject("Agent chat TUI connects, renders the feed, and sends", async ({ terminal }) => {
  // Header names the project + agent; the composer invites input.
  await expect(terminal.getByText(agentName, { strict: false })).toBeVisible();
  await expect(terminal.getByText("Message the agent", { strict: false })).toBeVisible();

  // The live subscription round trip completes (capnweb websocket + subscribe).
  await expect(terminal.getByText("live", { strict: false })).toBeVisible();

  // Empty feed hint renders from the reduced model, not raw events.
  await expect(terminal.getByText("No messages yet", { strict: false })).toBeVisible();

  // Send a message: it must come BACK through the server subscription and the
  // shared agent-ui reducer before it can render as a settled feed item.
  terminal.write("hello from microsoft tui test");
  terminal.submit();

  await expect(terminal.getByText("you ›", { strict: false })).toBeVisible();
  await expect(
    terminal.getByText("hello from microsoft tui test", { strict: false }),
  ).toBeVisible();

  const view = terminal.serialize().view;
  expect(view).toContain(agentName);
  expect(view).toContain(projectId);
  expect(view).toContain("●");
  expect(view).toContain("Message the agent");
  expect(view).not.toContain("raw event");
});

snapshotTest("captures a manual aesthetic snapshot", async ({ terminal }) => {
  await expect(terminal.getByText(agentName, { strict: false })).toBeVisible();

  terminal.submit("snapshot review message");

  await expect(terminal.getByText("snapshot review message", { strict: false })).toBeVisible();
  await expect(terminal).toMatchSnapshot({ includeColors: true });
});
