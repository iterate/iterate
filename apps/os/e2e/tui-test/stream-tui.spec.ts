import { expect, test } from "@microsoft/tui-test";
import { SPEC_EXPECT_TIMEOUT_MS } from "@iterate-com/shared/test-support/e2e-policy";

// TUI Test 0.0.4 does not load the config-level expect timeout in its worker,
// so cold-start assertions need the shared budget at each async matcher.
const visible = { timeout: SPEC_EXPECT_TIMEOUT_MS };

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
  // TUI Test owns only the terminal harness. The app starts through the same
  // public `pnpm iterate chat` bin a user runs; run.ts builds first and forces
  // that bin onto dist, so a source-only success cannot make this spec green.
  // The OS base URL comes from its throwaway XDG config and auth comes from the
  // admin secret in the inherited Doppler environment.
  // Primary API reference: https://github.com/microsoft/tui-test#terminal-program
  program: {
    file: "pnpm",
    args: ["-w", "iterate", "chat", "--project", projectId, "--agent-path", agentPath],
  },
});

testWithProject("Agent chat TUI connects, renders the feed, and sends", async ({ terminal }) => {
  // Wait for a UI-only marker first. The PTY echoes the launch command before
  // OpenTUI enters alternate-screen mode, and that command contains agentName.
  await expect(terminal.getByText("Message the agent", { strict: false })).toBeVisible(visible);
  await expect(terminal.getByText(agentName, { strict: false })).toBeVisible(visible);

  // The live subscription round trip completes (capnweb websocket + subscribe).
  await expect(terminal.getByText("live", { strict: false })).toBeVisible(visible);

  // The feed renders from the reduced model, not raw events: a fresh agent
  // stream's first fold produces the wake marker item (agent-ui-reducer's
  // STREAM_WAKE_LABEL), not a raw event dump.
  await expect(terminal.getByText("Stream durable object woke", { strict: false })).toBeVisible(
    visible,
  );

  // Send a message: it must come BACK through the server subscription and the
  // shared agent-ui reducer before it can render as a settled feed item.
  terminal.write("hello from microsoft tui test");
  terminal.submit();

  await expect(terminal.getByText("you ›", { strict: false })).toBeVisible(visible);
  await expect(terminal.getByText("hello from microsoft tui test", { strict: false })).toBeVisible(
    visible,
  );

  const view = terminal.serialize().view;
  expect(view).toContain(agentName);
  expect(view).toContain(projectId);
  expect(view).toContain("●");
  expect(view).toContain("Message the agent");
  expect(view).not.toContain("raw event");
});

testWithProject(
  "starts the existing computer provider from /use-my-computer",
  async ({ terminal }) => {
    await expect(terminal.getByText("live", { strict: false })).toBeVisible();

    terminal.submit("/use-my-computer");

    await expect(terminal.getByText("itx.", { strict: false })).toBeVisible();
    const view = terminal.serialize().view;
    expect(view).not.toContain("you › /use-my-computer");
  },
);

snapshotTest("captures a manual aesthetic snapshot", async ({ terminal }) => {
  await expect(terminal.getByText("Message the agent", { strict: false })).toBeVisible(visible);
  await expect(terminal.getByText(agentName, { strict: false })).toBeVisible(visible);

  terminal.submit("snapshot review message");

  await expect(terminal.getByText("snapshot review message", { strict: false })).toBeVisible(
    visible,
  );
  await expect(terminal).toMatchSnapshot({ includeColors: true });
});
