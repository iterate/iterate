// git-wire.test.ts — the git codecs' unit pins (blob/tree/commit ids exactly as git computes
// them, the manifest ⇄ tree round trip) and the wire's one refusal that matters: a TRUNCATED pkt-line
// body is an outage, never an empty ref list. Pure: no DO, no bindings; `fetch` is stubbed where the
// transport is exercised. The packs themselves are pinned against the real endpoint deployed
// (test/vitest/os/cfartifacts.e2e.test.ts), against the local fake remote (test/helpers/
// fake-git-server.ts) and, for GitHub's fetch, in github-template.test.ts.

import { expect, onTestFinished, test, vi } from "vitest";
import {
  buildPack,
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
  parsePack,
  parseTree,
  readCapped,
  pktFrames,
  pktLine,
  pktText,
  redactRemote,
  type RawGitObject,
  type RepoManifest,
  treeObjectsOf,
  ZERO_OID,
} from "./git-wire.ts";

/** A tip the fake remote's ls-refs names. */
const TIP = "aaaaabbbbbccccc111112222233333aaaaabbbbb";

// ── git wire ── the wire's one refusal that matters to the repo facet: a TRUNCATED pkt-line body is
// an outage, never an empty ref list (an empty list reads as "unborn repo" → "no file", which would
// silently blank the config worker's source).

test("a pkt-line body cut mid-header rejects instead of yielding an empty ref list", async () => {
  vi.stubGlobal("fetch", async () => new Response("00", { status: 200 }));
  const transport = createGitWireTransport({
    remote: "https://account.artifacts.example/git/ns/prj.config.git",
    authorization: "Basic eDp0",
  });
  await expect(transport.tipOf("refs/heads/main")).rejects.toThrow(/truncated pkt-line/);
});

// ── Artifacts 5xx ── a git-upload-pack only reads, so the one Artifacts answered 5xx is sent ONCE
// more a second later (jittered to between half and all of it), logged as
// `repo.platform-failure-retry`; a second 5xx, a 4xx and a push's 5xx fail at once.

test.for([
  {
    name: "a read answered 503 once is sent again a second later, logged, and answers",
    send: "tipOf",
    statuses: [503, 200],
    outcome: { answer: TIP },
    lines: [{ event: "repo.platform-failure-retry", status: 503, attempt: 1, retryInMs: 750 }],
  },
  {
    name: "a read answered 5xx twice fails with the second answer",
    send: "tipOf",
    statuses: [502, 503],
    outcome: {
      error: "git-upload-pack responded 503 for https://artifacts.example/prj.git: unavailable",
    },
    lines: [
      { event: "repo.platform-failure-retry", status: 502, attempt: 1, retryInMs: 750 },
      { event: "repo.platform-failure-gave-up", status: 503, attempts: 2 },
    ],
  },
  {
    name: "a read answered 4xx fails at once: an answer about the request",
    send: "tipOf",
    statuses: [401],
    outcome: {
      error: "git-upload-pack responded 401 for https://artifacts.example/prj.git: unavailable",
    },
    lines: [],
  },
  {
    name: "a push answered 503 is never sent twice",
    send: "push",
    statuses: [503],
    outcome: {
      error: "git-receive-pack responded 503 for https://artifacts.example/prj.git: unavailable",
    },
    lines: [],
  },
] as const)("Artifacts 5xx: $name", async ({ send, statuses, outcome, lines }) => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5); // a 1 s wait jittered to 750 ms
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const answers = [...statuses];
  const fetch = vi.fn(async () => {
    const status = answers.shift()!;
    return status === 200
      ? new Response(concat([pktLine(`${TIP} refs/heads/main`), FLUSH]), { status })
      : new Response("unavailable", { status });
  });
  vi.stubGlobal("fetch", fetch);
  onTestFinished(() => void vi.useRealTimers());
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
    lines.map((line) => ({
      kind: "disconnected",
      name: "git-upload-pack",
      remote: "https://artifacts.example/prj.git",
      message: `Error: git-upload-pack responded ${line.status} for https://artifacts.example/prj.git: unavailable`,
      ...line,
    })),
  );
});

// ── no answer ── a request that gets no whole answer in time (`GIT_REQUEST_TIMEOUT_MS` in
// ./git-wire.ts says why).

test("a read that gets no answer in 20 s is aborted and sent once more", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5); // a 1 s wait jittered to 750 ms
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const signals: AbortSignal[] = [];
  vi.stubGlobal("fetch", async (_request: Request, init: RequestInit) => {
    signals.push(init.signal!);
    if (signals.length === 1) return new Promise<Response>(() => {});
    return new Response(concat([pktLine(`${TIP} refs/heads/main`), FLUSH]));
  });
  onTestFinished(() => void vi.useRealTimers());
  const transport = createGitWireTransport({
    remote: "https://artifacts.example/prj.git",
    authorization: "Basic eDp0",
  });
  const tip = transport.tipOf("refs/heads/main");
  await vi.advanceTimersByTimeAsync(20_000 + 750);
  expect(await tip).toBe(TIP);
  expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
  expect(warn.mock.calls.map(([line]) => line)).toEqual([
    {
      event: "repo.platform-failure-retry",
      kind: "disconnected",
      name: "git-upload-pack",
      remote: "https://artifacts.example/prj.git",
      status: "network",
      attempt: 1,
      retryInMs: 750,
      message:
        "GitRequestTimeout: git-upload-pack for https://artifacts.example/prj.git answered nothing in 20 s",
    },
  ]);
});

test("a push that gets no answer in 20 s fails, and is never sent twice", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", fetch);
  onTestFinished(() => void vi.useRealTimers());
  const transport = createGitWireTransport({
    remote: "https://artifacts.example/prj.git",
    authorization: "Basic eDp0",
  });
  const pushed = transport
    .push({ newOid: TIP, oldOid: ZERO_OID, pack: new Uint8Array(), ref: "refs/heads/main" })
    .then(
      (answer) => ({ answer }),
      (error: Error) => ({ error: error.message }),
    );
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await pushed).toEqual({
    error: "git-receive-pack for https://artifacts.example/prj.git answered nothing in 20 s",
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

// ── the tree codec ── nested trees encode to git's OWN object ids. The expected ids were computed with
// `git` over the same three files (a.txt "hello\n", dir/b.txt "world\n", dir/sub/c.txt "deep\n";
// author iterate <config@iterate.com>, 1700000000 +0000, message "first"), so `commitFiles`'s
// nested-directory encoding — entry order, the directory mode, the commit header — is pinned to git.
// Each id is checked by its first 7 hex digits, as git abbreviates one.

test("the tree codec against git's ids: treeObjectsOf encodes nested directories to git's tree ids; manifestOf flattens them back", async () => {
  const manifest = await threeFiles();
  const { rootOid, trees } = await treeObjectsOf(manifest);
  expect(rootOid.slice(0, 7)).toBe("56418d8");
  expect(trees.map((tree) => tree.oid.slice(0, 7)).sort()).toEqual(
    [
      "56418d8", // the root
      "62f4835", // dir
      "7b0c5d2", // dir/sub
    ].sort(),
  );
  const objects = new Map(
    trees.map((tree) => [
      tree.oid,
      { oid: tree.oid, type: "tree" as const, payload: tree.payload },
    ]),
  );
  expect(manifestOf(parseTree(objects.get(rootOid)!.payload), objects)).toEqual(manifest);
});

test("the tree codec against git's ids: hashObject is git's blob id; encodeCommit hashes to git's commit id and parseCommit reads it back", async () => {
  const blob = await hashObject("blob", new TextEncoder().encode("hello\n"));
  expect(blob.slice(0, 7)).toBe("ce01362");
  const { rootOid } = await treeObjectsOf(await threeFiles());
  const commit = encodeCommit({
    author: { name: "iterate", email: "config@iterate.com", date: new Date(1_700_000_000_000) },
    committer: { name: "iterate", email: "config@iterate.com" },
    message: "first\n", // git's own commits end their message with a newline
    parents: [],
    tree: rootOid,
  });
  expect((await hashObject("commit", commit)).slice(0, 7)).toBe("322f6b7");
  expect(parseCommit(commit)).toEqual({
    tree: rootOid,
    parents: [],
    author: { name: "iterate", email: "config@iterate.com" },
    committer: { name: "iterate", email: "config@iterate.com" },
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
      userinfo: { user: "x-access-token", password: PLACEHOLDER },
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
  expect(gitRemoteOf(remote)).toMatchObject(becomes);
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
      committer: { name: "a", email: "a@example.com" },
      message,
      parents,
      tree: "aaaaabbbbbccccc111112222233333aaaaabbbbb",
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

test("an untrusted pack is bounded: an object over the cap, or an entry that inflates past its declared size, fails before it is kept", async () => {
  expect(
    await parsePack(await buildPack([{ type: "blob", payload: new Uint8Array(10) }])),
  ).toMatchObject([{ type: "blob" }]);
  const big = await buildPack([{ type: "blob", payload: new Uint8Array(2_000_000) }]);
  await expect(parsePack(big, { maxObjectBytes: 1_000_000 })).rejects.toThrow(
    /exceeds 1000000 bytes/,
  );
  // One entry whose header declares ONE byte while its zlib stream inflates to a megabyte.
  const honest = await buildPack([{ type: "blob", payload: new Uint8Array(1_000_000) }]);
  let cursor = 12; // the entry's header: type and size, 7 bits a byte after the first 4
  while (honest[cursor]! & 0x80) cursor += 1;
  const lying = concat([
    honest.subarray(0, 12),
    Uint8Array.of((3 << 4) | 1),
    honest.subarray(cursor + 1, honest.length - 20),
  ]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", lying));
  await expect(parsePack(concat([lying, digest]))).rejects.toThrow(
    /inflates past its declared 1 byte/,
  );
});

test("a response body over the cap is refused before it is all read", async () => {
  await expect(readCapped(new Response(new Uint8Array(3_000)), 1_000)).rejects.toThrow(
    /more than 1000 bytes/,
  );
  expect(await readCapped(new Response("ok"), 1_000)).toEqual(new TextEncoder().encode("ok"));
});

test("redactRemote drops a credential whatever the scheme or its case", () => {
  expect(redactRemote("HTTPS://x:TOKEN@github.com/a/b.git")).toBe("HTTPS://github.com/a/b.git");
  expect(redactRemote("ftp://u:TOKEN@example.com/r.git")).toBe("ftp://example.com/r.git");
  expect(redactRemote("https://github.com/a/b.git")).toBe("https://github.com/a/b.git");
  expect(redactRemote("https://x:p@ss@github.com/a/b.git")).toBe("https://github.com/a/b.git");
});

/** The tree codec's three files, each at the blob id git gives its contents. */
async function threeFiles(): Promise<RepoManifest> {
  const blob = (text: string) => hashObject("blob", new TextEncoder().encode(text));
  return new Map([
    ["a.txt", { oid: await blob("hello\n"), mode: "100644" }],
    ["dir/b.txt", { oid: await blob("world\n"), mode: "100644" }],
    ["dir/sub/c.txt", { oid: await blob("deep\n"), mode: "100644" }],
  ]);
}

/** `user:password` as a Basic header value, UTF-8 first. */
function basic(credential: string): string {
  return `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(credential)))}`;
}
