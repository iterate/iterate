import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createMachineCapability, type MachineInvocation, truncate } from "./machine-capability.ts";

test("write → glob → read roundtrip, with each call announced to the TUI", async () => {
  await using dir = await tempDir();
  const { machine, invocations } = machineUnderTest();

  await machine.writeFile({ path: join(dir.path, "hello.txt"), content: "hi there" });
  const { matches } = await machine.glob({ pattern: "*.txt", cwd: dir.path });
  expect(matches).toEqual(["hello.txt"]);

  const { content } = await machine.readFile({ path: join(dir.path, matches[0]) });
  expect(content).toBe("hi there");

  expect(invocations.map((i) => i.method)).toEqual(["writeFile", "glob", "readFile"]);
});

test("exec captures stdout and a non-zero exit code without throwing", async () => {
  const { machine } = machineUnderTest();

  await expect(machine.exec({ command: "echo hello" })).resolves.toMatchObject({
    stdout: "hello\n",
    exitCode: 0,
  });
  await expect(machine.exec({ command: "exit 3" })).resolves.toMatchObject({ exitCode: 3 });
});

test("truncate marks how much it dropped", () => {
  expect(truncate("abcdef", 3)).toBe("abc\n…[3 more chars truncated]");
  expect(truncate("ab", 3)).toBe("ab");
});

function machineUnderTest() {
  const invocations: MachineInvocation[] = [];
  const machine = createMachineCapability({
    onInvocation: (invocation) => invocations.push(invocation),
  });
  return { machine, invocations };
}

async function tempDir() {
  const path = await fs.mkdtemp(join(tmpdir(), "machine-capability-"));
  return {
    path,
    async [Symbol.asyncDispose]() {
      await fs.rm(path, { recursive: true, force: true });
    },
  };
}
