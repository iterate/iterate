// context/durable-object-names.test.ts — the codec's projectId charset gate, applied at parse:
// `[A-Za-z0-9_-]` only, because a ":" in a projectId would breach the `${projectId}:` kv/secret
// isolation wall (project A addressing project B's cell). The dotted `.iterate/<path>` half is
// unpoliced — a ":" in a PATH segment survives, the kv prefix is the projectId alone.
import { expect, test } from "vitest";
import { DurableObjectNameCodec } from "./durable-object-names.ts";

test("every projectId shape the codebase actually uses parses cleanly", () => {
  for (const id of ["prj_demo", "prj_x", "me", "prj_fd_lsbad", "prj_am-forge", "PRJ_UP", "a1"]) {
    expect(() => DurableObjectNameCodec.parse(id)).not.toThrow();
    expect(DurableObjectNameCodec.parse(id).projectId).toBe(id);
  }
});

test("a full context name (projectId + dotted .iterate path) still parses; the path is unpoliced", () => {
  const n = "prj_demo.iterate/agents/support-bot";
  expect(DurableObjectNameCodec.parse(n).name).toBe(n);
  expect(DurableObjectNameCodec.parse(n).projectId).toBe("prj_demo");
  const withColonPath = DurableObjectNameCodec.stringify({ projectId: "prj_u", path: "/x:y" });
  expect(() => DurableObjectNameCodec.parse(withColonPath)).not.toThrow();
});

test("a ':' (or other breach char) in the projectId is rejected loudly", () => {
  expect(() => DurableObjectNameCodec.parse("prj_x:evil")).toThrow(/only \[A-Za-z0-9_-\]/);
  expect(() => DurableObjectNameCodec.parse("prj/x")).toThrow(/only \[A-Za-z0-9_-\]/);
});

test("`/a`, `/a/`, `/a/./`, `a` and `//a` are ONE name — the codec canonicalizes like cd() does, so no door (the ?context= query included) can mint a twin DO for a logical context", () => {
  const canonical = DurableObjectNameCodec.stringify({ projectId: "prj_t", path: "/a" });
  expect(canonical).toBe("prj_t.iterate/a");
  for (const path of ["/a", "/a/", "/a/./", "a", "a/", "//a", "/b/../a"])
    expect(DurableObjectNameCodec.stringify({ projectId: "prj_t", path })).toBe(canonical);
  for (const name of ["prj_t.iterate/a/", "prj_t.iterate/a/./", "prj_t.iterate//a"])
    expect(DurableObjectNameCodec.parse(name)).toEqual({
      projectId: "prj_t",
      path: "/a",
      name: canonical,
    });
  // the root's spellings collapse the same way
  for (const name of [
    "prj_t",
    "prj_t.iterate",
    "prj_t.iterate/",
    "prj_t.iterate/./",
    "prj_t.iterate/..",
  ])
    expect(DurableObjectNameCodec.parse(name).name).toBe("prj_t.iterate/");
});
