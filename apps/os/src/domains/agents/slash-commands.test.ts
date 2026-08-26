import { expect, test } from "vitest";
import { resolveSlashCommand } from "./slash-commands.ts";

test("/example resolves a catalogue slug into the shared run-script envelope", () => {
  const resolved = resolveSlashCommand('/example describe-project {"who":"me"}');
  expect(resolved).toMatchObject({ command: "example" });
  expect(resolved!.code).toContain('const vars = {"who":"me"};');
  expect(resolved!.code.startsWith("async (itx) => {")).toBe(true);
});

test("/example only resolves entries the run-script door can actually run", () => {
  // `whoami` is session-context (needs the OS Session, no itx here) and
  // `run-script` is a project entry without the run-script runtime — both
  // fall through to the LLM instead of silently doing nothing.
  expect(resolveSlashCommand("/example whoami")).toBeNull();
  expect(resolveSlashCommand("/example run-script")).toBeNull();
});

test("anything that does not resolve falls through to the model as plain text", () => {
  // Unknown command, unknown slug, malformed vars, bare slash-ish text: all
  // null — the model explains typos better than a hard error would.
  expect(resolveSlashCommand("/frobnicate now")).toBeNull();
  expect(resolveSlashCommand("/example not-a-real-slug")).toBeNull();
  expect(resolveSlashCommand("/example whoami {broken json")).toBeNull();
  expect(resolveSlashCommand("/example whoami [1,2]")).toBeNull();
  // The retired /script command is an unknown command now, like any other.
  expect(resolveSlashCommand("/script await itx.__describe()")).toBeNull();
  expect(resolveSlashCommand("what about 1/2 of the budget?")).toBeNull();
});
