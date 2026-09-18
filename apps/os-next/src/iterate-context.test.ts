// iterate-context.test.ts — the context's pure half: the durable-object name codec.

import { expect, test, vi } from "vitest";

// The module under test reaches classes from "cloudflare:workers" (RpcTarget, DurableObject,
// WorkerEntrypoint, the pipelining brands), which node cannot resolve — mock JUST those base classes
// (no-op shells); the module's own logic runs unmodified.
vi.mock("cloudflare:workers", () => ({
  RpcTarget: class {},
  DurableObject: class {},
  WorkerEntrypoint: class {},
  RpcPromise: class {},
  RpcProperty: class {},
}));
import { DurableObjectNameCodec, resourceScope } from "./iterate-context.ts";

// ── durable object names ── the codec's projectId charset gate, applied at parse:
// `[A-Za-z0-9_-]` only, because a ":" in a projectId would breach the `${projectId}:` kv/secret
// isolation wall (project A addressing project B's cell). The dotted `.iterate/<path>` half is
// unpoliced — a ":" in a PATH segment survives, the kv prefix is the projectId alone.

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

// ── the resource owner ── `resourceScope(projectId, path)`: the ONE derivation behind every
// resource key (the kv prefix, a secret cell's name, the Artifacts prefix) and the secrets root.
// A project owns its resources whole; the global namespace splits by owner subtree.

test.each([
  // a project: byte-identical keys, whatever the path — even its own `/users/<id>` context
  { projectId: "prj_demo", path: "/", becomes: { id: "prj_demo", rootPath: "/" } },
  { projectId: "prj_demo", path: "/agents/x", becomes: { id: "prj_demo", rootPath: "/" } },
  { projectId: "prj_demo", path: "/users/u1", becomes: { id: "prj_demo", rootPath: "/" } },
  // the global namespace: the owner subtree, its root the secrets root
  {
    projectId: "global",
    path: "/users/u1",
    becomes: { id: "global--users--u1", rootPath: "/users/u1" },
  },
  {
    projectId: "global",
    path: "/users/u1/notes",
    becomes: { id: "global--users--u1", rootPath: "/users/u1" },
  },
  {
    projectId: "global",
    path: "/organizations/o1",
    becomes: { id: "global--organizations--o1", rootPath: "/organizations/o1" },
  },
  // the global root, and any global path not under an owner: the kernel's own
  { projectId: "global", path: "/", becomes: { id: "global", rootPath: "/" } },
  { projectId: "global", path: "/other", becomes: { id: "global", rootPath: "/" } },
  { projectId: "global", path: "/users", becomes: { id: "global", rootPath: "/" } },
])("resourceScope($projectId, $path) is $becomes", ({ projectId, path, becomes }) => {
  expect(resourceScope(projectId, path)).toEqual(becomes);
});

test("a global owner's id keeps the codec's charset (the `:`/`.` delimiters cannot collide), an owner id outside it is refused, and no project slug can spell it", () => {
  for (const path of [
    "/users/user_google_1234",
    "/users/user_8f3a-1c2d",
    "/organizations/org_admin",
  ]) {
    const { id } = resourceScope("global", path);
    expect(() => DurableObjectNameCodec.address({ projectId: id, path: "/" })).not.toThrow();
    // a project's id is minted, `prj_<hex>` — never a global scope's id
    expect(id).not.toMatch(/^prj_/);
  }
  expect(() => resourceScope("global", "/users/a:b")).toThrow(/only \[A-Za-z0-9_-\]/);
  expect(() => resourceScope("global", "/organizations/o.1")).toThrow(/only \[A-Za-z0-9_-\]/);
});
