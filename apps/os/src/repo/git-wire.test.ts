// src/repo/git-wire.test.ts — the git codecs' unit pins (blob/tree/commit ids exactly as git computes
// them, the manifest ⇄ tree round trip) and the wire's one refusal that matters: a TRUNCATED pkt-line
// body is an outage, never an empty ref list. Pure: no DO, no bindings; `fetch` is stubbed where the
// transport is exercised. The packs themselves are pinned against the real endpoint deployed
// (e2e/cfartifacts.e2e.test.ts) and against the local fake remote (e2e/support/fake-git-server.ts).

import { describe, expect, test, afterEach, vi } from "vitest";
import {
  createGitWireTransport,
  encodeCommit,
  hashObject,
  manifestOf,
  parseCommit,
  parseTree,
  type RepoManifest,
  treeObjectsOf,
} from "./git-wire.ts";

// ── git wire ── the wire's one refusal that matters to the repo facet: a TRUNCATED pkt-line body is
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

describe("the tree codec against git's ids", () => {
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
