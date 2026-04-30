import { expect, test } from "@microsoft/tui-test";

const streamPath = `/microsoft-tui-test-${Date.now()}`;

test.use({
  columns: 100,
  rows: 32,
  // TUI Test owns only the terminal harness. The app still starts through the
  // same iterate-app-cli path a user runs from the repo root.
  // Primary API reference: https://github.com/microsoft/tui-test#terminal-program
  program: {
    file: "pnpm",
    args: [
      "--dir",
      "../..",
      "cli",
      "stream-tui",
      "--project-slug",
      "public",
      "--stream-path",
      streamPath,
    ],
  },
});

test("Stream TUI starts and accepts slash command input", async ({ terminal }) => {
  await expect(terminal.getByText(streamPath, { strict: false })).toBeVisible();

  terminal.write("/m");

  await expect(terminal.getByText("Append an agent-style user message")).toBeVisible();

  terminal.submit();

  await expect(terminal.getByText("/append.message", { strict: false })).toBeVisible();

  terminal.write("hello from microsoft tui test");
  terminal.submit();

  await expect(
    terminal.getByText("events.iterate.com/agent/input-added", { strict: false }),
  ).toBeVisible();

  terminal.write("/e");

  await expect(terminal.getByText("Append a built-in error event")).toBeVisible();

  terminal.submit();

  await expect(terminal.getByText("/append.error", { strict: false })).toBeVisible();

  terminal.submit("boom from microsoft tui test");

  await expect(
    terminal.getByText("https://events.iterate.com/events/stream/error-occurred", {
      strict: false,
    }),
  ).toBeVisible();

  terminal.submit("/streams");

  await expect(terminal.getByText("current", { strict: false })).toBeVisible();

  const view = terminal.serialize().view;
  expect(view).toContain(streamPath);
  expect(view).toContain("●");
  expect(view).toContain("Type a message or / for commands");
  expect(view).toContain("current");
  expect(view).not.toContain("raw event");

  terminal.write("\t");
  await expect(terminal.getByText("Streams focus:", { strict: false })).toBeVisible();

  terminal.write(`/microsoft-tui-test`);

  await expect(terminal.getByText(` /microsoft-tui-test`, { strict: false })).toBeVisible();
  await expect(terminal.getByText(streamPath, { strict: false })).toBeVisible();
});

test.when(
  process.env.AGENTS_TUI_SNAPSHOT === "1",
  "captures a manual aesthetic snapshot",
  async ({ terminal }) => {
    await expect(terminal.getByText(streamPath, { strict: false })).toBeVisible();

    terminal.submit("snapshot review message");

    await expect(terminal.getByText("snapshot review message", { strict: false })).toBeVisible();
    await expect(terminal).toMatchSnapshot({ includeColors: true });
  },
);
