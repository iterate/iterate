import { expect, test } from "vitest";
import { resolveSlashCommand } from "./slash-commands.ts";

test("/script wraps a single expression with an implicit return", () => {
  const resolved = resolveSlashCommand("/script await itx.__describe()");
  expect(resolved).toMatchObject({ command: "script" });
  expect(resolved!.code).toBe("async (itx) => {\nreturn (await itx.__describe());\n}");
});

test("/script runs statement-shaped code verbatim, stripping a markdown fence", () => {
  const resolved = resolveSlashCommand(
    "/script ```ts\nconst me = await itx.__describe();\nreturn me.projectId;\n```",
  );
  expect(resolved!.code).toBe(
    "async (itx) => {\nconst me = await itx.__describe();\nreturn me.projectId;\n}",
  );
});

test("/script never return-wraps statement keywords, even on one line", () => {
  // `return (throw …)` is a parse error — one-line throw/try/switch/do must
  // run verbatim like the other statement forms.
  expect(resolveSlashCommand('/script throw new Error("boom")')!.code).toBe(
    'async (itx) => {\nthrow new Error("boom")\n}',
  );
  expect(resolveSlashCommand("/script try { risky() } catch {}")!.code).toBe(
    "async (itx) => {\ntry { risky() } catch {}\n}",
  );
});

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
  expect(resolveSlashCommand("/script")).toBeNull();
  expect(resolveSlashCommand("what about 1/2 of the budget?")).toBeNull();
});
