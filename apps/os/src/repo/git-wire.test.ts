// git-wire.test.ts — the git codecs' unit pins (blob/tree/commit ids exactly as git computes
// them, the manifest ⇄ tree round trip) and the wire's one refusal that matters: a TRUNCATED pkt-line
// body is an outage, never an empty ref list. Pure: no DO, no bindings; `fetch` is stubbed where the
// transport is exercised. The packs themselves are pinned against the real endpoint deployed
// (apps/os/e2e/cfartifacts.e2e.test.ts), against the local fake remote (apps/os/e2e/support/
// fake-git-server.ts) and, for GitHub's fetch, in github-template.test.ts.

import { expect, onTestFinished, test, vi } from "vitest";
import {
  commitReaches,
  concat,
  createGitWireTransport,
  encodeCommit,
  encodeFetchRequest,
  gitRemoteOf,
  FLUSH,
  hashObject,
  manifestOf,
  parseCommit,
  parseTree,
  pktFrames,
  pktLine,
  pktText,
  type RawGitObject,
  type RepoManifest,
  treeObjectsOf,
  ZERO_OID,
} from "./git-wire.ts";

/** A tip the fake remote's ls-refs names. */
const TIP = "322f6b7736f1636a850cfc3d3d639730b0882514";

// ── git wire ── the wire's one refusal that matters to the repo facet: a TRUNCATED pkt-line body is
// an outage, never an empty ref list (an empty list reads as "unborn repo" → "no file", which would
// silently blank the config worker's source).

test("a pkt-line body cut mid-header rejects instead of yielding an empty ref list", async () => {
  vi.stubGlobal("fetch", async () => new Response("00", { status: 200 }));
  onTestFinished(() => void vi.unstubAllGlobals());
  const transport = createGitWireTransport({
    remote: "https://account.artifacts.example/git/ns/prj.config.git",
    authorization: "Basic eDp0",
  });
  await expect(transport.tipOf("refs/heads/main")).rejects.toThrow(/truncated pkt-line/);
});

// ── Artifacts 5xx ── a git-upload-pack only reads, so the one Artifacts answered 5xx is sent ONCE
// more a second later, logged as `repo.platform-failure-retry`; a second 5xx, a 4xx and a push's 5xx
// fail at once.

test.for([
  {
    name: "a read answered 503 once is sent again a second later, logged, and answers",
    send: "tipOf",
    statuses: [503, 200],
    outcome: { answer: TIP },
    retries: [{ name: "git-upload-pack", status: 503, attempt: 1, retryInMs: 1_000 }],
  },
  {
    name: "a read answered 5xx twice fails with the second answer",
    send: "tipOf",
    statuses: [502, 503],
    outcome: { error: "git-upload-pack responded 503 for https://artifacts.example/prj.git" },
    retries: [{ name: "git-upload-pack", status: 502, attempt: 1, retryInMs: 1_000 }],
  },
  {
    name: "a read answered 4xx fails at once: an answer about the request",
    send: "tipOf",
    statuses: [401],
    outcome: { error: "git-upload-pack responded 401 for https://artifacts.example/prj.git" },
    retries: [],
  },
  {
    name: "a push answered 503 is never sent twice",
    send: "push",
    statuses: [503],
    outcome: { error: "git-receive-pack responded 503 for https://artifacts.example/prj.git" },
    retries: [],
  },
] as const)("Artifacts 5xx: $name", async ({ send, statuses, outcome, retries }) => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const answers = [...statuses];
  const fetch = vi.fn(async () => {
    const status = answers.shift()!;
    return status === 200
      ? new Response(concat([pktLine(`${TIP} refs/heads/main`), FLUSH]), { status })
      : new Response("unavailable", { status });
  });
  vi.stubGlobal("fetch", fetch);
  onTestFinished(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    warn.mockRestore();
  });
  const transport = createGitWireTransport({
    remote: "https://artifacts.example/prj.git",
    authorization: "Basic eDp0",
  });
  const settled = (
    send === "tipOf"
      ? transport.tipOf("refs/heads/main")
      : transport.push({
          newOid: TIP,
          oldOid: ZERO_OID,
          pack: new Uint8Array(),
          ref: "refs/heads/main",
        })
  ).then(
    (answer) => ({ answer }),
    (error: Error) => ({ error: error.message }),
  );
  await vi.runAllTimersAsync();
  expect(await settled).toEqual(outcome);
  expect(fetch).toHaveBeenCalledTimes(statuses.length);
  expect(warn.mock.calls.map(([line]) => line)).toEqual(
    retries.map((retry) => ({
      event: "repo.platform-failure-retry",
      remote: "https://artifacts.example/prj.git",
      ...retry,
    })),
  );
});

// ── the tree codec ── nested trees encode to git's OWN object ids. The expected ids were computed with
// `git` over the same three files (a.txt "hello\n", dir/b.txt "world\n", dir/sub/c.txt "deep\n";
// author iterate <config@iterate.com>, 1700000000 +0000, message "first"), so `commitFiles`'s
// nested-directory encoding — entry order, the directory mode, the commit header — is pinned to git.

const manifest: RepoManifest = new Map([
  ["a.txt", { oid: "ce013625030ba8dba906f756967f9e9ca394464a", mode: "100644" }],
  ["dir/b.txt", { oid: "cc628ccd10742baea8241c5924df992b5c019f71", mode: "100644" }],
  ["dir/sub/c.txt", { oid: "4cdb2265d30204be5463b38174b2e8e717982405", mode: "100644" }],
]);
const ROOT_TREE = "56418d827d2ac1d9c1b21c7161407dfde86f9e9b";

test("the tree codec against git's ids: treeObjectsOf encodes nested directories to git's tree ids; manifestOf flattens them back", async () => {
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

test("the tree codec against git's ids: hashObject is git's blob id; encodeCommit hashes to git's commit id and parseCommit reads it back", async () => {
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

// ── remotes ── a git remote is an http(s) URL; its userinfo becomes a Basic credential and leaves the
// URL, as git and curl do. A secret placeholder may sit in it, raw or percent-encoded: egress
// substitutes it inside the credential (secrets.ts), so no token is ever spelled here.

const PLACEHOLDER = 'getSecret("/secrets/github-acme", { field: "accessToken" })';

test.for([
  {
    remote: "https://github.com/acme/config.git",
    becomes: { url: "https://github.com/acme/config.git", authorization: null },
  },
  {
    remote: `https://x-access-token:${PLACEHOLDER}@github.com/acme/config.git`,
    becomes: {
      url: "https://github.com/acme/config.git",
      authorization: basic(`x-access-token:${PLACEHOLDER}`),
    },
  },
  {
    remote: `https://x-access-token:${encodeURIComponent(PLACEHOLDER)}@github.com/acme/config.git`,
    becomes: {
      url: "https://github.com/acme/config.git",
      authorization: basic(`x-access-token:${PLACEHOLDER}`),
    },
  },
  {
    remote: "http://someone@127.0.0.1:8123/repo.git/",
    becomes: { url: "http://127.0.0.1:8123/repo.git", authorization: basic("someone:") },
  },
] as const)("gitRemoteOf($remote)", ({ remote, becomes }) => {
  expect(gitRemoteOf(remote)).toEqual(becomes);
});

test.for([
  "git@github.com:acme/config.git",
  "ssh://git@github.com/acme/config.git",
  "https://github.com/acme/config.git?x=1",
  "https://github.com/acme/config.git#main",
  "https:///acme/config.git",
  "",
])("gitRemoteOf(%j) refuses: not an http(s) git URL", (remote) => {
  expect(() => gitRemoteOf(remote)).toThrow(/not an http\(s\) git URL/);
});

test("a fetch request names what the client has, so the pack carries only what it lacks", () => {
  const lines = [
    ...pktFrames(encodeFetchRequest({ wants: ["a".repeat(40)], haves: ["b".repeat(40)] })),
  ]
    .filter((frame) => frame.kind === "line")
    .map((frame) => pktText(frame.payload));
  expect(lines).toEqual([
    "command=fetch",
    `want ${"a".repeat(40)}`,
    `have ${"b".repeat(40)}`,
    "no-progress",
    "done",
  ]);
});

test("commitReaches: along every parent within the objects, and onto a parent the objects stop at", async () => {
  const objects = new Map<string, RawGitObject>();
  const commit = async (message: string, parents: string[]) => {
    const payload = encodeCommit({
      author: { name: "a", email: "a@example.com", date: new Date(0) },
      message,
      parents,
      tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    });
    const oid = await hashObject("commit", payload);
    objects.set(oid, { oid, type: "commit", payload });
    return oid;
  };
  const outside = "c".repeat(40); // a commit the client already has: the pack stops at it
  const a = await commit("a", [outside]);
  const b = await commit("b", [a]);
  const side = await commit("side", [outside]);
  const merge = await commit("merge", [b, side]);
  expect(commitReaches(objects, merge, a)).toBe(true);
  expect(commitReaches(objects, merge, side)).toBe(true);
  expect(commitReaches(objects, merge, outside)).toBe(true);
  expect(commitReaches(objects, merge, merge)).toBe(true);
  expect(commitReaches(objects, a, b)).toBe(false);
  expect(commitReaches(objects, b, side)).toBe(false);
  expect(commitReaches(objects, b, "d".repeat(40))).toBe(false);
});

/** `user:password` as a Basic header value, UTF-8 first. */
function basic(credential: string): string {
  return `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(credential)))}`;
}
