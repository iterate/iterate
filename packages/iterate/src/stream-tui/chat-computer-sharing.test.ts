import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { expect, test } from "vitest";
import { buildUseMyComputerCommand, createChatComputerSharing } from "./chat-computer-sharing.ts";

test("launches the maintained JSON provider for this project and computer name", () => {
  expect(
    buildUseMyComputerCommand({
      cliPath: "/opt/iterate/bin/iterate.js",
      configName: "preview_3",
      name: "joebloggsComputer",
      projectId: "prj_test",
    }),
  ).toEqual({
    command: "bun",
    args: [
      "/opt/iterate/bin/iterate.js",
      "--config",
      "preview_3",
      "use-my-computer",
      "--json",
      "--project",
      "prj_test",
      "--name",
      "joebloggsComputer",
    ],
  });
});

test("starts one provider and reports when the named computer is live", () => {
  const process = new FakeProviderProcess();
  let launches = 0;
  const sharing = createChatComputerSharing({
    launch: () => {
      launches += 1;
      return process;
    },
    name: "joebloggsComputer",
  });

  sharing.start();
  sharing.start();
  process.stdout.write(
    `${JSON.stringify({ type: "status", loggedIn: true, project: "prj_test", name: "joebloggsComputer" })}\n`,
  );

  expect(launches).toBe(1);
  expect(sharing.snapshot()).toMatchObject({
    status: "live",
    notice: "shared itx.joebloggsComputer for this chat",
  });
});

test("ignores blank lines between provider events", () => {
  const process = new FakeProviderProcess();
  const sharing = createChatComputerSharing({
    launch: () => process,
    name: "joebloggsComputer",
  });

  sharing.start();
  process.stdout.write(
    `${JSON.stringify({ type: "status", loggedIn: true, project: "prj_test", name: "joebloggsComputer" })}\n\n`,
  );

  expect(sharing.snapshot()).toMatchObject({
    status: "live",
    notice: "shared itx.joebloggsComputer for this chat",
  });
});

test("surfaces provider reconnection without launching another provider", () => {
  const process = new FakeProviderProcess();
  const sharing = createChatComputerSharing({
    launch: () => process,
    name: "joebloggsComputer",
  });

  sharing.start();
  process.stdout.write(
    `${JSON.stringify({ type: "status", loggedIn: true, project: "prj_test", name: "joebloggsComputer", reconnecting: true })}\n`,
  );

  expect(sharing.snapshot()).toMatchObject({
    status: "reconnecting",
    notice: "itx.joebloggsComputer dropped — reconnecting",
  });
});

test("surfaces a capability-name conflict", () => {
  const process = new FakeProviderProcess();
  const sharing = createChatComputerSharing({
    launch: () => process,
    name: "joebloggsComputer",
  });

  sharing.start();
  process.stdout.write(
    `${JSON.stringify({ type: "status", loggedIn: true, project: "prj_test", name: "joebloggsComputer", conflict: true })}\n`,
  );

  expect(sharing.snapshot()).toMatchObject({
    status: "error",
    notice: "another session took itx.joebloggsComputer",
  });
});

test("shows machine calls and their failures", () => {
  const process = new FakeProviderProcess();
  const sharing = createChatComputerSharing({
    launch: () => process,
    name: "joebloggsComputer",
  });

  sharing.start();
  process.stdout.write(
    `${JSON.stringify({ type: "call", id: 1, method: "runSwift", summary: "read the current directory" })}\n`,
  );
  expect(sharing.snapshot()).toMatchObject({
    status: "live",
    notice: "itx.joebloggsComputer.runSwift: read the current directory",
  });

  process.stdout.write(
    `${JSON.stringify({ type: "call-done", id: 1, method: "runSwift", ok: false, error: "permission denied" })}\n`,
  );
  expect(sharing.snapshot()).toMatchObject({
    status: "error",
    notice: "itx.joebloggsComputer.runSwift failed: permission denied",
  });
});

test("returns to the shared indicator after a successful machine call", () => {
  const process = new FakeProviderProcess();
  const sharing = createChatComputerSharing({
    launch: () => process,
    name: "joebloggsComputer",
  });

  sharing.start();
  process.stdout.write(
    `${JSON.stringify({ type: "call-done", id: 1, method: "notify", ok: true })}\n`,
  );

  expect(sharing.snapshot()).toMatchObject({
    status: "live",
    notice: "shared itx.joebloggsComputer for this chat",
  });
});

test("surfaces a provider process failure", () => {
  const process = new FakeProviderProcess();
  const sharing = createChatComputerSharing({
    launch: () => process,
    name: "joebloggsComputer",
  });

  sharing.start();
  process.emit("error", new Error("bun was not found"));

  expect(sharing.snapshot()).toMatchObject({
    status: "error",
    notice: "could not share itx.joebloggsComputer: bun was not found",
  });
});

test("closes the provider input when chat releases the sharing controller", () => {
  const process = new FakeProviderProcess();
  const sharing = createChatComputerSharing({
    launch: () => process,
    name: "joebloggsComputer",
  });

  sharing.start();
  sharing[Symbol.dispose]();

  expect(process.stdin.writableEnded).toBe(true);
});

test("ignores provider output that arrives after chat releases the controller", () => {
  const process = new FakeProviderProcess();
  const sharing = createChatComputerSharing({
    launch: () => process,
    name: "joebloggsComputer",
  });

  sharing.start();
  sharing[Symbol.dispose]();
  process.stdout.write(
    `${JSON.stringify({ type: "status", loggedIn: true, project: "prj_test", name: "joebloggsComputer" })}\n`,
  );
  process.stderr.write("late provider error\n");

  expect(sharing.snapshot()).toMatchObject({ status: "idle", notice: "" });
});

test("reports an unexpected provider exit and allows an explicit retry", async () => {
  const processes = [new FakeProviderProcess(), new FakeProviderProcess()];
  let launches = 0;
  const sharing = createChatComputerSharing({
    launch: () => processes[launches++]!,
    name: "joebloggsComputer",
  });

  sharing.start();
  processes[0]!.emit("exit", 7);
  await endProviderStdout(processes[0]!);
  expect(sharing.snapshot()).toMatchObject({
    status: "error",
    notice: "itx.joebloggsComputer stopped unexpectedly (exit 7)",
  });

  sharing.start();
  expect(launches).toBe(2);
});

test("reports a provider crash even when the last machine call failed", async () => {
  const process = new FakeProviderProcess();
  const sharing = createChatComputerSharing({
    launch: () => process,
    name: "joebloggsComputer",
  });

  sharing.start();
  process.stdout.write(
    `${JSON.stringify({ type: "call-done", id: 1, method: "runSwift", ok: false, error: "permission denied" })}\n`,
  );
  process.emit("exit", 9);
  await endProviderStdout(process);

  expect(sharing.snapshot()).toMatchObject({
    status: "error",
    notice: "itx.joebloggsComputer stopped unexpectedly (exit 9)",
  });
});

test("classifies non-event provider output as a visible failure", () => {
  const process = new FakeProviderProcess();
  const sharing = createChatComputerSharing({
    launch: () => process,
    name: "joebloggsComputer",
  });

  sharing.start();
  process.stdout.write("null\n");

  expect(sharing.snapshot()).toMatchObject({
    status: "error",
    notice: "itx.joebloggsComputer emitted invalid status output",
  });
});

test("reports when the provider cannot use the chat login", () => {
  const process = new FakeProviderProcess();
  const sharing = createChatComputerSharing({
    launch: () => process,
    name: "joebloggsComputer",
  });

  sharing.start();
  process.stdout.write(`${JSON.stringify({ type: "status", loggedIn: false })}\n`);

  expect(sharing.snapshot()).toMatchObject({
    status: "error",
    notice: "itx.joebloggsComputer needs a fresh iterate login",
  });
});

test("reads a terminal provider status that drains after process exit", async () => {
  const process = new FakeProviderProcess();
  const sharing = createChatComputerSharing({
    launch: () => process,
    name: "joebloggsComputer",
  });

  sharing.start();
  process.emit("exit", 1);
  process.stdout.write(`${JSON.stringify({ type: "status", loggedIn: false })}\n`);
  await endProviderStdout(process);

  expect(sharing.snapshot()).toMatchObject({
    status: "error",
    notice: "itx.joebloggsComputer needs a fresh iterate login",
  });
});

test("surfaces provider diagnostics written to stderr", () => {
  const process = new FakeProviderProcess();
  const sharing = createChatComputerSharing({
    launch: () => process,
    name: "joebloggsComputer",
  });

  sharing.start();
  process.stderr.write("capability types did not compile\n");

  expect(sharing.snapshot()).toMatchObject({
    status: "error",
    notice: "could not share itx.joebloggsComputer: capability types did not compile",
  });
});

class FakeProviderProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
}

function endProviderStdout(process: FakeProviderProcess) {
  return new Promise<void>((resolve) => {
    process.stdout.once("end", resolve);
    process.stdout.end();
  });
}
