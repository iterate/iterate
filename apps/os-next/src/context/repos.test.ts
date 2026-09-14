// context/repos.test.ts — the repos' unit pins: `itx.cfArtifacts` (the raw binding, project-scoped,
// pure over an injected namespace) and the git wire's one refusal that matters to `itx.git`.

import { describe, expect, test, afterEach, vi } from "vitest";
import {
  projectScopedArtifacts,
  ScopedArtifactRepo,
  type ArtifactRepoHandle,
  type ArtifactsNamespace,
  createGitWireTransport,
  encodeCommit,
  hashObject,
  manifestOf,
  parseCommit,
  parseTree,
  type RepoManifest,
  treeObjectsOf,
} from "./repos.ts";

// ── cfArtifacts ── `itx.cfArtifacts`, the RAW Cloudflare Artifacts binding, project-
// scoped and SHAPED like the real binding (create/get/list return the real shapes). Two isolation
// properties are what matter, and both are enforced HERE, not by the binding:
//   1. NAMES are forced under the caller's `${projectId}.` prefix — a `.` delimiter, because project
//      IDs are `[A-Za-z0-9_-]` (no `.`), so it cannot collide even when IDs contain `-` (a `--`
//      delimiter would: `a`+`b--x` == `a--b`+`x`). `list` is filtered to that prefix LOCALLY (the
//      binding returns EVERY project's repos).
//   2. `get` returns the real handle's shape MINUS `fork` — whose runtime `fork(name)` (walked by the
//      itx dispatcher regardless of the narrowed type) takes an unprefixed name and escapes the wall.
// Pure over an injected namespace: no DO, no bindings, no network.

function recordingNamespace(allRepos: string[] = []) {
  const calls: { method: string; name: string }[] = [];
  let forkCalled = false;
  const namespace: ArtifactsNamespace = {
    create: async (name) => {
      calls.push({ method: "create", name });
      return { token: `tok-${name}` };
    },
    get: async (name) => {
      calls.push({ method: "get", name });
      // A real-shaped handle that ALSO carries the UNSAFE `fork(dest)` — `get` must re-expose
      // `createToken` but NEVER this method.
      return {
        createToken: async (scope: "read" | "write", ttlSeconds: number) => ({
          plaintext: `${scope}-${name}-${ttlSeconds}`,
        }),
        fork: async (dest: string) => {
          forkCalled = true;
          return { token: `stolen-${dest}` };
        },
      } as unknown as ArtifactRepoHandle;
    },
    list: async () => {
      calls.push({ method: "list", name: "*" });
      return { repos: allRepos.map((name) => ({ name })) };
    },
    delete: async (name) => {
      calls.push({ method: "delete", name });
      return true;
    },
  };
  return { namespace, calls, forkCalled: () => forkCalled };
}

test("cfArtifacts prefixes with a '.' delimiter and re-exposes the handle WITHOUT fork", async () => {
  const { namespace, calls, forkCalled } = recordingNamespace();
  const a = projectScopedArtifacts(namespace, "prj_a");

  expect((await a.create("config")).token).toBe("tok-prj_a.config");
  expect(calls.at(-1)).toEqual({ method: "create", name: "prj_a.config" }); // prefixed on the way in

  const repo = await a.get("config");
  expect(calls.at(-1)).toEqual({ method: "get", name: "prj_a.config" }); // prefixed on the way in
  // The handle is an RpcTarget wrapper (so `get(name).createToken(...)` pipelines across /api), and it
  // re-exposes ONLY createToken, acting on the already-prefixed repo…
  expect(repo).toBeInstanceOf(ScopedArtifactRepo);
  expect((await repo.createToken("read", 60)).plaintext).toBe("read-prj_a.config-60");
  // …while fork is NOT reachable on it (its unprefixed name would escape the project wall).
  expect((repo as unknown as Record<string, unknown>).fork).toBeUndefined();
  expect(forkCalled()).toBe(false);

  expect(await a.delete("config")).toBe(true);
  expect(calls.at(-1)).toEqual({ method: "delete", name: "prj_a.config" }); // prefixed on the way in
});

test("the '.' delimiter is collision-free for hyphenated project IDs; list filters locally", async () => {
  // A '--' delimiter would alias `prj_a` with `prj_a-b`. With '.', the prefixes `prj_a.` and
  // `prj_a-b.` are disjoint, so a raw (unfiltered) binding list is still split cleanly by project.
  const { namespace } = recordingNamespace(["prj_a.site", "prj_a-b.secret", "prj_a.docs"]);

  const a = projectScopedArtifacts(namespace, "prj_a");
  expect((await a.list()).repos.map((r) => r.name).sort()).toEqual(["docs", "site"]); // NOT prj_a-b's

  const ab = projectScopedArtifacts(namespace, "prj_a-b");
  expect((await ab.list()).repos.map((r) => r.name)).toEqual(["secret"]);
});

// ── git wire ── the wire's one refusal that matters to `itx.git`: a TRUNCATED pkt-line body is
// an outage, never an empty ref list (an empty list reads as "unborn repo" → "no file", which would
// silently blank the config worker's source).

afterEach(() => vi.unstubAllGlobals());

test("a pkt-line body cut mid-header rejects instead of yielding an empty ref list", async () => {
  vi.stubGlobal("fetch", async () => new Response("00", { status: 200 }));
  const transport = createGitWireTransport({
    remote: "https://account.artifacts.example/git/ns/prj.config.git",
    token: "t",
  });
  await expect(transport.tipOf("refs/heads/main")).rejects.toThrow(/truncated pkt-line/);
});

// ── the tree codec ── nested trees encode to git's OWN object ids. The expected ids were computed with
// `git` over the same three files (a.txt "hello\n", dir/b.txt "world\n", dir/sub/c.txt "deep\n";
// author iterate <config@iterate.com>, 1700000000 +0000, message "first"), so `commitFiles`'s
// nested-directory encoding — entry order, the directory mode, the commit header — is pinned to git.

describe("itx.git's tree codec against git's ids", () => {
  const manifest: RepoManifest = new Map([
    ["a.txt", { oid: "ce013625030ba8dba906f756967f9e9ca394464a", mode: "100644" }],
    ["dir/b.txt", { oid: "cc628ccd10742baea8241c5924df992b5c019f71", mode: "100644" }],
    ["dir/sub/c.txt", { oid: "4cdb2265d30204be5463b38174b2e8e717982405", mode: "100644" }],
  ]);
  const ROOT_TREE = "56418d827d2ac1d9c1b21c7161407dfde86f9e9b";

  test("treeObjectsOf encodes nested directories to git's tree ids; manifestOf flattens them back", async () => {
    const { rootOid, trees } = await treeObjectsOf(manifest);
    expect(rootOid).toBe(ROOT_TREE);
    expect(trees.map((tree) => tree.oid).sort()).toEqual(
      [
        ROOT_TREE,
        "62f4835d0012f43ee010ec7ad340e9a99958ce0d", // dir
        "7b0c5d2afa30e0b524990e5c6f6a5bc4dd63a09a", // dir/sub
      ].sort(),
    );
    const objects = new Map(
      trees.map((tree) => [
        tree.oid,
        { oid: tree.oid, type: "tree" as const, payload: tree.payload },
      ]),
    );
    expect(manifestOf(parseTree(objects.get(ROOT_TREE)!.payload), objects)).toEqual(manifest);
  });

  test("hashObject is git's blob id; encodeCommit hashes to git's commit id and parseCommit reads it back", async () => {
    expect(await hashObject("blob", new TextEncoder().encode("hello\n"))).toBe(
      "ce013625030ba8dba906f756967f9e9ca394464a",
    );
    const commit = encodeCommit({
      author: { name: "iterate", email: "config@iterate.com", date: new Date(1_700_000_000_000) },
      message: "first\n", // git's own commits end their message with a newline
      parents: [],
      tree: ROOT_TREE,
    });
    expect(await hashObject("commit", commit)).toBe("322f6b7736f1636a850cfc3d3d639730b0882514");
    expect(parseCommit(commit)).toEqual({
      tree: ROOT_TREE,
      parents: [],
      author: { name: "iterate", email: "config@iterate.com" },
      timestamp: 1_700_000_000_000,
      message: "first",
    });
  });
});
