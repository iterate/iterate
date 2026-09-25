// src/repo/durable-object.test.ts — THE READ AT A COMMIT is one fetch however many callers ask at once
// (`RepoDurableObject#fresh`): a commit's files never change, so every concurrent
// `modules({ commitOid })` waits on the one read in flight, and a read that fails leaves nothing
// behind for the next caller. THE GIT CREDENTIALS outlive an incarnation: a fresh one reuses the
// stored remote and a token with life left, and asks the binding for nothing. The facet runs in Node
// against the e2e's fake git remote (e2e/support/fake-artifacts.ts), which speaks the real wire and
// counts the packs it served; the whole repo story is e2e/repos.e2e.test.ts. PULL AND PUSH keep a
// repo's main and a remote's main ONE history: the pack is forwarded unchanged, so commits keep their
// oids and a picture its bytes; fast-forward only unless `force`; the remote is named, or origin.

import { errorCode } from "iterate/lib";
import { reduceProcessor } from "iterate/stream/test-support";
import { expect, onTestFinished, test, vi } from "vitest";
import { FakeArtifacts } from "../../e2e/support/fake-artifacts.ts";
import {
  projectScopedArtifacts,
  repoPathOf,
  type ArtifactRepoHandle,
  type ArtifactsNamespace,
} from "../context/cf-artifacts.ts";
import { DurableObjectNameCodec } from "../context/paths.ts";
import { RepoDurableObject } from "./durable-object.ts";

const path = "/repos/config";

test.for([
  { name: "50 concurrent reads at one commit fetch its pack once", callers: 50, failFirst: false },
  {
    name: "a read that fails fails its 5 waiters together; the next read fetches again and answers",
    callers: 5,
    failFirst: true,
  },
])("$name", async ({ callers, failFirst }) => {
  const artifacts = await FakeArtifacts.start({ [path]: { "worker.ts": "export default 1;\n" } });
  onTestFinished(() => artifacts.close());
  const commitOid = artifacts.remoteTip(path)!;
  const realFetch = globalThis.fetch;
  let failNext = failFirst;
  vi.stubGlobal("fetch", (...args: Parameters<typeof fetch>) => {
    if (!failNext) return realFetch(...args);
    failNext = false;
    return Promise.reject(new Error("Artifacts answered 503"));
  });
  onTestFinished(() => void vi.unstubAllGlobals());
  const repo = repoFacet(artifacts);

  const wave = await Promise.allSettled(
    Array.from({ length: callers }, () => repo.modules({ commitOid })),
  );
  const next = await repo.modules({ commitOid });

  expect(wave.map((outcome) => outcome.status)).toEqual(
    Array(callers).fill(failFirst ? "rejected" : "fulfilled"),
  );
  expect(next).toEqual({ "worker.ts": "export default 1;\n" });
  // the fake remote counts only the packs it SERVED: a rejected fetch never reached it
  const packsServed = artifacts.snapshots;
  expect(packsServed).toBe(1);
});

test("a repo's first read asks the binding for its remote once and mints one token", async () => {
  const { artifacts, calls, cfArtifacts } = await countingArtifacts();
  expect(await repoFacet(cfArtifacts).modules()).toEqual({ "worker.ts": "export default 1;\n" });
  expect(calls).toEqual({ get: 2, info: 1, createToken: 1 });
  expect(artifacts).toMatchObject({ snapshots: 1 });
});

test("a fresh incarnation reuses the stored remote and token: a cold load asks the binding for nothing", async () => {
  const { artifacts, calls, cfArtifacts } = await countingArtifacts();
  const storage = memoryStorage();
  await repoFacet(cfArtifacts, storage).modules();
  const warm = { ...calls };

  // A new object over the same storage: nothing in memory, the pack fetched again.
  expect(await repoFacet(cfArtifacts, storage).modules()).toEqual({
    "worker.ts": "export default 1;\n",
  });
  expect(calls).toEqual(warm);
  expect(artifacts).toMatchObject({ snapshots: 2 });
});

test("a fresh incarnation whose stored token is inside the reuse margin mints one, with no remote asked", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => void vi.useRealTimers());
  const { calls, cfArtifacts } = await countingArtifacts();
  const storage = memoryStorage();
  await repoFacet(cfArtifacts, storage).modules();
  calls.get = calls.info = calls.createToken = 0;

  // 300 s of life, reused until 60 s before its end
  vi.setSystemTime(Date.now() + 239_000);
  await repoFacet(cfArtifacts, storage).modules();
  expect(calls).toEqual({ get: 0, info: 0, createToken: 0 });
  vi.setSystemTime(Date.now() + 2_000);
  await repoFacet(cfArtifacts, storage).modules();
  expect(calls).toEqual({ get: 1, info: 0, createToken: 1 });
});

test("push sends main to an empty remote; pull brings the remote's next commit back with its own oid, and lands the commit's fact; again, each is up to date", async () => {
  const { artifacts, remote } = await withRemote();
  const { repo, appended } = syncingRepo(artifacts);
  const seed = artifacts.remoteTip(path)!;

  expect(await repo.push({ remote })).toEqual({
    status: "updated",
    commitOid: seed,
    previousOid: null,
  });
  expect(artifacts.remoteTip(GITHUB)).toBe(seed);
  const { commitOid: edit } = await artifacts.pushFromOutside(GITHUB, {
    message: "Edit on GitHub",
    changes: [{ path: "README.md", content: "hi\n" }],
  });
  expect(await repo.pull({ remote })).toEqual({
    status: "updated",
    commitOid: edit,
    previousOid: seed,
  });
  expect(artifacts.remoteTip(path)).toBe(edit);
  expect(await repo.readFile("README.md")).toBe("hi\n");
  const fact = {
    type: "events.iterate.com/repo/commit-completed",
    payload: { path, commitOid: edit, message: "Edit on GitHub", changedPaths: ["README.md"] },
  };
  expect(appended).toEqual([
    { at: "/", ...fact },
    { at: path, ...fact },
  ]);
  expect(await repo.pull({ remote })).toEqual({
    status: "up-to-date",
    commitOid: edit,
    previousOid: edit,
  });
  expect(await repo.push({ remote })).toEqual({
    status: "up-to-date",
    commitOid: edit,
    previousOid: edit,
  });
});

test("diverged mains: pull and push refuse NOT_FAST_FORWARD and move nothing; a forced pull resets ours to theirs, a forced push theirs to ours", async () => {
  const { artifacts, remote } = await withRemote();
  const { repo, appended } = syncingRepo(artifacts);
  await repo.push({ remote });
  const { commitOid: theirs } = await artifacts.pushFromOutside(GITHUB, {
    message: "theirs",
    changes: [{ path: "a.md", content: "github\n" }],
  });
  const { commitOid: ours } = await repo.commitFiles({
    message: "ours",
    changes: [{ path: "b.md", content: "iterate\n" }],
  });
  appended.length = 0;

  const diverged = { code: "NOT_FAST_FORWARD", data: { ours, theirs } };
  expect(await refusal(repo.pull({ remote }))).toEqual(diverged);
  expect(await refusal(repo.push({ remote }))).toEqual(diverged);
  expect([artifacts.remoteTip(path), artifacts.remoteTip(GITHUB)]).toEqual([ours, theirs]);
  expect(appended).toEqual([]);

  expect(await repo.pull({ remote, force: true })).toEqual({
    status: "updated",
    commitOid: theirs,
    previousOid: ours,
  });
  expect(artifacts.remoteFiles(path)).toEqual(artifacts.remoteFiles(GITHUB));
  expect(appended.map(({ at, payload }) => [at, payload])).toEqual(
    ["/", path].map((at) => [
      at,
      { path, commitOid: theirs, message: "theirs", changedPaths: ["a.md", "b.md"] },
    ]),
  );

  const { commitOid: mine } = await repo.commitFiles({
    message: "mine",
    changes: [{ path: "c.md", content: "c\n" }],
  });
  await artifacts.pushFromOutside(GITHUB, {
    message: "lost",
    changes: [{ path: "d.md", content: "d\n" }],
  });
  expect(await repo.push({ remote, force: true })).toMatchObject({
    status: "updated",
    commitOid: mine,
  });
  expect(artifacts.remoteTip(GITHUB)).toBe(mine);
});

test("a picture pulled keeps its bytes, and a text commit pushed on top of it leaves them as they were", async () => {
  const { artifacts, remote } = await withRemote();
  const { repo } = syncingRepo(artifacts);
  await repo.push({ remote });
  const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0xff, 0xfe, 1);
  await artifacts.pushFromOutside(GITHUB, {
    message: "A logo",
    changes: [{ path: "logo.png", bytes: png }],
  });
  await repo.pull({ remote });
  expect(artifacts.remoteBytes(path, "logo.png")).toEqual(png);
  await repo.commitFiles({ message: "text", changes: [{ path: "README.md", content: "r\n" }] });
  expect(await repo.push({ remote })).toMatchObject({ status: "updated" });
  expect(artifacts.remoteBytes(GITHUB, "logo.png")).toEqual(png);
  expect(artifacts.remoteTip(GITHUB)).toBe(artifacts.remoteTip(path));
});

test("origin: setOrigin records it on the repo's log; pull and push default to it, sending its userinfo as a Basic credential through the context's egress, never in the URL", async () => {
  const { artifacts, remote } = await withRemote();
  const placeholder = 'getSecret("/secrets/github-acme", { field: "accessToken" })';
  const origin = remote.replace("http://", `http://x-access-token:${placeholder}@`);
  const { repo, appended, requests } = syncingRepo(artifacts, origin);

  expect(await repo.setOrigin(origin)).toEqual({ origin });
  expect(await repo.setOrigin(null)).toEqual({ origin: null });
  expect(appended).toEqual(
    [origin, null].map((value) => ({
      at: path,
      type: "events.iterate.com/repo/origin-set",
      payload: { origin: value },
    })),
  );
  await expect(repo.setOrigin("git@github.com:acme/config.git")).rejects.toThrow(
    /not an http\(s\) git URL/,
  );

  expect(await repo.origin()).toBe(origin);
  expect(await repo.push()).toMatchObject({ status: "updated" });
  const toRemote = requests.filter(({ url }) => url.startsWith(remote));
  expect(toRemote.length).toBeGreaterThan(0);
  const credential = `Basic ${btoa(`x-access-token:${placeholder}`)}`;
  expect(toRemote.every(({ authorization }) => authorization === credential)).toBe(true);
  expect(requests.every(({ url }) => !url.includes("getSecret"))).toBe(true);

  const none = syncingRepo(artifacts).repo;
  await expect(none.pull()).rejects.toThrow(/no origin/);
});

test("a remote behind ours: pull is up to date and moves nothing; a forced pull resets main back to it, and a return to a commit published before lands a new fact", async () => {
  const { artifacts, remote } = await withRemote();
  const { repo, appended } = syncingRepo(artifacts);
  const seed = artifacts.remoteTip(path)!;
  await repo.push({ remote });
  const { commitOid: ahead } = await repo.commitFiles({
    message: "ahead",
    changes: [{ path: "a.md", content: "a\n" }],
  });
  expect(await repo.pull({ remote })).toEqual({
    status: "up-to-date",
    commitOid: ahead,
    previousOid: ahead,
  });
  appended.length = 0;

  expect(await repo.pull({ remote, force: true })).toEqual({
    status: "updated",
    commitOid: seed,
    previousOid: ahead,
  });
  expect(artifacts.remoteTip(path)).toBe(seed);
  // back to the seed, which was published before: a new fact
  expect(appended.filter((event) => event.at === path)).toMatchObject([
    { payload: { commitOid: seed, message: "seed", changedPaths: ["a.md"] } },
  ]);
  expect(await repo.pull({ remote })).toMatchObject({ status: "up-to-date" });
  expect(appended.filter((event) => event.at === path)).toHaveLength(1);
});

test("a pull whose fact was lost settles it before it answers up to date; a commit and a pull at once run one after the other", async () => {
  const { artifacts, remote } = await withRemote();
  const { repo, appended, failNextAppendAt } = syncingRepo(artifacts);
  await repo.push({ remote });
  const { commitOid: theirs } = await artifacts.pushFromOutside(GITHUB, {
    message: "theirs",
    changes: [{ path: "t.md", content: "t\n" }],
  });
  failNextAppendAt("/");
  await expect(repo.pull({ remote })).rejects.toThrow(/root refused/);
  expect(artifacts.remoteTip(path)).toBe(theirs); // the pull landed in git, not its fact
  expect(await repo.pull({ remote })).toMatchObject({ status: "up-to-date", commitOid: theirs });
  expect(appended.filter((event) => event.at === path)).toMatchObject([
    { payload: { commitOid: theirs, changedPaths: ["t.md"] } },
  ]);

  appended.length = 0;
  await artifacts.pushFromOutside(GITHUB, {
    message: "next",
    changes: [{ path: "n.md", content: "n\n" }],
  });
  const [committed, pulled] = await Promise.allSettled([
    repo.commitFiles({ message: "mine", changes: [{ path: "m.md", content: "m\n" }] }),
    repo.pull({ remote }),
  ]);
  // one after the other: the pull meets the commit on main, a divergence, and says so
  expect(committed).toMatchObject({ status: "fulfilled" });
  expect(pulled).toMatchObject({ status: "rejected", reason: { code: "NOT_FAST_FORWARD" } });
  expect(appended.filter((event) => event.at === path)).toMatchObject([
    { payload: { message: "mine" } },
  ]);
});

test("an origin holds a secret placeholder, never a token: a literal credential is refused without being echoed, in any letter case", async () => {
  const { artifacts } = await withRemote();
  const { repo, appended } = syncingRepo(artifacts);
  const token = "ghs_literalSecretValue123";
  for (const origin of [
    `https://x-access-token:${token}@github.com/acme/config.git`,
    `HTTPS://x-access-token:${token}@github.com/acme/config.git`,
    `https://${token}@github.com/acme/config.git`,
    `ftp://x:${token}@example.com/r.git`,
    `https://${token}:getSecret("/secrets/git")@github.com/acme/config.git`,
    `https://x:getSecret(${token})@github.com/acme/config.git`,
    `https://x:getSecret("/secrets/git")${token}@github.com/acme/config.git`,
    `https://x:p@${token}@github.com/acme/config.git`,
  ]) {
    const refused = await repo.setOrigin(origin).then(
      () => "set",
      (error: Error) => error.message,
    );
    expect(refused).toMatch(/placeholder|not an http\(s\) git URL/);
    expect(refused).not.toContain("literalSecret");
    expect(refused).not.toContain(token);
  }
  expect(appended).toEqual([]);
});

test("a pull or push handed no caller's egress is refused before it reaches any remote", async () => {
  const { artifacts, remote } = await withRemote();
  const repo = repoFacet(artifacts);
  for (const call of [repo.pull({ remote }), repo.push({ remote })])
    expect(await refusal(call)).toMatchObject({ code: "INVALID_INPUT" });
});

test("origin-set is reduced into the repo's state: set, replaced, forgotten; a payload that is no origin is skipped", () => {
  const originSet = (origin: unknown) => ({
    type: "events.iterate.com/repo/origin-set",
    payload: { origin },
  });
  const { processor } = repoFacet({});
  const state = (events: { type: string; payload: unknown }[]) =>
    reduceProcessor(processor, events).origin;
  expect(state([])).toBeNull();
  expect(state([originSet("https://a.example/r.git")])).toBe("https://a.example/r.git");
  expect(state([originSet("https://a.example/r.git"), originSet("https://b.example/r.git")])).toBe(
    "https://b.example/r.git",
  );
  expect(state([originSet("https://a.example/r.git"), originSet(null)])).toBeNull();
  expect(state([originSet("https://a.example/r.git"), originSet(7)])).toBe(
    "https://a.example/r.git",
  );
});

/** The repo facet on `path`, created, reaching `cfArtifacts` as its context's `itx.cfArtifacts`, over
 *  `storage` — its durable storage, which a second facet over the same one finds as a fresh
 *  incarnation does. */
function repoFacet(
  cfArtifacts: unknown,
  storage = memoryStorage(),
  itx: Record<string, unknown> = {},
  origin: string | null = null,
): RepoDurableObject {
  const ctx = {
    props: {
      iterateContextName: DurableObjectNameCodec.stringify({ projectId: "prj_repo", path }),
    },
    storage,
  } as unknown as DurableObjectState;
  const repo = new RepoDurableObject(ctx, {
    ITX: { get: () => ({ cfArtifacts, ...itx }) },
  } as never);
  vi.spyOn(repo, "snapshot").mockResolvedValue({
    offset: 1,
    state: { creation: { status: "created", offset: 1 }, deletion: null, origin },
  } as never);
  return repo;
}

/** A repo facet over `artifacts` whose context answers the two appends of a commit's fact (on `/`,
 *  then on the repo's path), recorded, and whose pull and push are handed the caller's egress. */
function syncingRepo(artifacts: FakeArtifacts, origin: string | null = null) {
  const appended: { at: string; type: string; payload: unknown }[] = [];
  const requests: { url: string; authorization: string | null }[] = [];
  let failAt: string | null = null;
  const record =
    (at: string) =>
    async (...events: { type: string; payload?: unknown }[]) => {
      if (failAt === at) {
        failAt = null;
        throw new Error(`the root refused the append at ${at}`);
      }
      for (const { type, payload } of events) appended.push({ at, type, payload });
      return events;
    };
  const repo = repoFacet(
    artifacts,
    memoryStorage(),
    { append: record(path), cd: (to: string) => ({ append: record(to) }) },
    origin,
  );
  // The caller's egress, which `itx.repos.get(path)` hands a pull or push (library.ts): here
  // straight to the fake server, each request recorded as the remote saw it.
  const egress = async (request: Request) => {
    requests.push({ url: request.url, authorization: request.headers.get("authorization") });
    return fetch(request);
  };
  const [pull, push] = [repo.pull.bind(repo), repo.push.bind(repo)];
  repo.pull = (options) => pull(options, egress);
  repo.push = (options) => push(options, egress);
  /** The next append on `at` throws, as a root refusing it would. */
  const failNextAppendAt = (at: string) => {
    failAt = at;
  };
  return { repo, appended, requests, failNextAppendAt };
}

/** A second repo on the fake server, standing for GitHub: the remote a pull or push names. */
const GITHUB = "/github/config";
async function withRemote(files: Record<string, string> = { "worker.ts": "export default 1;\n" }) {
  const artifacts = await FakeArtifacts.start({ [path]: files });
  onTestFinished(() => artifacts.close());
  artifacts.create(GITHUB);
  return { artifacts, remote: artifacts.get(GITHUB).remote() };
}

/** The refusal a call rejected with: its code and data. */
const refusal = (call: Promise<unknown>) =>
  call.then(
    () => "resolved",
    (error: { data?: unknown }) => ({ code: errorCode(error), data: error.data }),
  );

/** The async key-value half of `ctx.storage`, in memory: values copied in and out, as stored. */
function memoryStorage() {
  const stored = new Map<string, unknown>();
  return {
    get: async (key: string) => structuredClone(stored.get(key)),
    put: async (key: string, value: unknown) => void stored.set(key, structuredClone(value)),
    delete: async (key: string) => stored.delete(key),
  };
}

/** The real proxy (`projectScopedArtifacts`) over a namespace that counts the binding's calls and
 *  hands out the fake remote's URL, reached as a facet reaches it through its context: every call on
 *  `get(path)`'s handle is a second dispatch, which walks `get(path)` again
 *  (packages/iterate/src/expression.ts). */
async function countingArtifacts() {
  const artifacts = await FakeArtifacts.start({ [path]: { "worker.ts": "export default 1;\n" } });
  onTestFinished(() => artifacts.close());
  const calls = { get: 0, info: 0, createToken: 0 };
  const namespace = {
    get: async (name: string) => {
      calls.get++;
      const remote = artifacts.get(repoPathOf(name.slice("prj_repo.".length))).remote();
      return {
        info: async () => {
          calls.info++;
          return { remote };
        },
        createToken: async () => {
          calls.createToken++;
          return { plaintext: "fake" };
        },
      } as unknown as ArtifactRepoHandle;
    },
  } as unknown as ArtifactsNamespace;
  const scope = projectScopedArtifacts({ namespace, projectId: "prj_repo" });
  const cfArtifacts = {
    get: (repoPath: string) => {
      void scope.get(repoPath);
      return {
        remote: async () => (await scope.get(repoPath)).remote(),
        createToken: async (tokenScope: "read" | "write", ttlSeconds: number) =>
          (await scope.get(repoPath)).createToken(tokenScope, ttlSeconds),
      };
    },
  };
  return { artifacts, calls, cfArtifacts };
}
