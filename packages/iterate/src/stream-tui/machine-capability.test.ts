import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createMachineCapability, type MachineInvocation, truncate } from "./machine-capability.ts";

test("write → glob → read → edit roundtrip, with each call announced to the TUI", async () => {
  await using dir = await tempDir();
  const { machine, invocations } = machineUnderTest();

  await machine.writeFile(join(dir.path, "hello.txt"), "hi there");

  const matches = await machine.glob("*.txt", dir.path);
  expect(matches).toMatchObject([{ name: "hello.txt", type: "file", size: 8 }]);

  expect(await machine.readFile(join(dir.path, "hello.txt"))).toBe("hi there");

  const { occurrenceCount } = await machine.edit({
    path: join(dir.path, "hello.txt"),
    oldString: "there",
    newString: "world",
  });
  expect(occurrenceCount).toBe(1);
  expect(await machine.readFile(join(dir.path, "hello.txt"))).toBe("hi world");

  expect(invocations.map((i) => i.method)).toEqual([
    "writeFile",
    "glob",
    "readFile",
    "edit",
    "readFile",
  ]);
});

test("readFile returns null for a missing file (matches itx.workspace)", async () => {
  await using dir = await tempDir();
  const { machine } = machineUnderTest();
  expect(await machine.readFile(join(dir.path, "nope.txt"))).toBeNull();
});

test("edit throws (rather than silently no-op) when oldString is absent", async () => {
  await using dir = await tempDir();
  const { machine } = machineUnderTest();
  await machine.writeFile(join(dir.path, "f.txt"), "alpha");
  await expect(
    machine.edit({ path: join(dir.path, "f.txt"), oldString: "beta", newString: "gamma" }),
  ).rejects.toThrow(/not found/);
});

test("edit refuses an ambiguous multi-match unless replaceAll is set (matches itx.workspace)", async () => {
  await using dir = await tempDir();
  const { machine } = machineUnderTest();
  const path = join(dir.path, "f.txt");
  await machine.writeFile(path, "x x x");

  await expect(machine.edit({ path, oldString: "x", newString: "y" })).rejects.toThrow(/matched 3/);
  expect(await machine.readFile(path)).toBe("x x x"); // unchanged — the file was not corrupted

  const result = await machine.edit({ path, oldString: "x", newString: "y", replaceAll: true });
  expect(result.occurrenceCount).toBe(3);
  expect(await machine.readFile(path)).toBe("y y y");
});

test("readDir lists entries as file-info objects", async () => {
  await using dir = await tempDir();
  const { machine } = machineUnderTest();
  await machine.writeFile(join(dir.path, "a.txt"), "a");
  await fs.mkdir(join(dir.path, "sub"));

  const entries = await machine.readDir(dir.path);
  expect(entries).toContainEqual(expect.objectContaining({ name: "a.txt", type: "file" }));
  expect(entries).toContainEqual(expect.objectContaining({ name: "sub", type: "directory" }));
});

test("exec captures stdout and a non-zero exit code without throwing", async () => {
  const { machine } = machineUnderTest();

  await expect(machine.exec("echo hello")).resolves.toMatchObject({
    stdout: "hello\n",
    exitCode: 0,
  });
  await expect(machine.exec("exit 3")).resolves.toMatchObject({ exitCode: 3 });
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
