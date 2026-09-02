// context/durable-object-names.test.ts — the codec's projectId charset gate, applied at parse:
// `[A-Za-z0-9_-]` only, because a ":" in a projectId would breach the `${projectId}:` kv/secret
// isolation wall (project A addressing project B's cell). The dotted `.iterate/<path>` half is
// unpoliced — a ":" in a PATH segment survives, the kv prefix is the projectId alone.
import { expect, test } from "vitest";
import { canonicalName, DurableObjectNameCodec } from "./durable-object-names.ts";

test("every projectId shape the codebase actually uses parses cleanly", () => {
  for (const id of ["prj_demo", "prj_x", "me", "prj_fd_lsbad", "prj_am-forge", "PRJ_UP", "a1"]) {
    expect(() => canonicalName(id)).not.toThrow();
    expect(DurableObjectNameCodec.parse(id).projectId).toBe(id);
  }
});

test("a full context name (projectId + dotted .iterate path) still parses; the path is unpoliced", () => {
  const n = "prj_demo.iterate/agents/support-bot";
  expect(canonicalName(n)).toBe(n);
  expect(DurableObjectNameCodec.parse(n).projectId).toBe("prj_demo");
  const withColonPath = DurableObjectNameCodec.stringify({ projectId: "prj_u", path: "/x:y" });
  expect(() => DurableObjectNameCodec.parse(withColonPath)).not.toThrow();
});

test("a ':' (or other breach char) in the projectId is rejected loudly", () => {
  expect(() => canonicalName("prj_x:evil")).toThrow(/only \[A-Za-z0-9_-\]/);
  expect(() => canonicalName("prj/x")).toThrow(/only \[A-Za-z0-9_-\]/);
});
