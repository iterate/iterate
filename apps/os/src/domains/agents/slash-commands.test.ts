import { expect, test } from "vitest";
import { buildSlashCommandCode, resolveSlashCommand } from "./slash-commands.ts";

test("/script wraps a single expression and appends its result as interruptive context", () => {
  const resolved = resolveSlashCommand("/script itx.__describe()");
  expect(resolved).toMatchObject({ command: "script" });
  const code = buildSlashCommandCode(resolved!, "slash-command:7");
  expect(code).toContain(
    "const result = await (async () => {\nreturn await (itx.__describe()\n);\n})();",
  );
  expect(code).toContain('type: "events.iterate.com/agents/context-added"');
  expect(code).toContain(
    'content: "User ran `/script itx.__describe()` command with the following result:\\n\\n"',
  );
  expect(code).toContain('actor: {"type":"script","executionId":"slash-command:7"}');
  expect(code).toContain('llmRequestPolicy: { behaviour: "interrupt-current-request" }');
  expect(code).toContain('idempotencyKey: "agent/slash-command-result@slash-command:7"');
  expect(code).toContain("return result;");
});

test("/script return wrap survives a trailing line comment", () => {
  // The closing paren lives on its own line, so `// note` cannot eat it.
  const resolved = resolveSlashCommand("/script await itx.__describe() // sanity check");
  expect(buildSlashCommandCode(resolved!, "slash-command:8")).toContain(
    "return await (itx.__describe() // sanity check\n);",
  );
});

test("/script runs statement-shaped code verbatim, stripping a markdown fence", () => {
  const resolved = resolveSlashCommand(
    "/script ```ts\nconst me = await itx.__describe();\nreturn me.projectId;\n```",
  );
  expect(buildSlashCommandCode(resolved!, "slash-command:9")).toContain(
    "const result = await (async () => {\nconst me = await itx.__describe();\nreturn me.projectId;\n})();",
  );
});

test("/script never return-wraps statement keywords, even on one line", () => {
  // `return (throw …)` is a parse error — one-line throw/try/switch/do must
  // run verbatim like the other statement forms.
  const throwing = resolveSlashCommand('/script throw new Error("boom")');
  expect(buildSlashCommandCode(throwing!, "slash-command:10")).toContain(
    'const result = await (async () => {\nthrow new Error("boom")\n})();',
  );
  const catching = resolveSlashCommand("/script try { risky() } catch {}");
  expect(buildSlashCommandCode(catching!, "slash-command:11")).toContain(
    "const result = await (async () => {\ntry { risky() } catch {}\n})();",
  );
});

test("/example resolves a catalogue slug into the shared run-script envelope", () => {
  const resolved = resolveSlashCommand('/example describe-project {"who":"me"}');
  expect(resolved).toMatchObject({ command: "example" });
  const code = buildSlashCommandCode(resolved!, "slash-command:12");
  expect(code).toContain('const vars = {"who":"me"};');
  expect(code.startsWith("async (itx) => {")).toBe(true);
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
