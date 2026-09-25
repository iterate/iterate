// context/cf-artifacts.test.ts — `itx.cfArtifacts`'s unit pins: the binding proxy (project-scoped, BY PATH,
// pure over an injected namespace) and the path → Artifacts-name mapping. Git itself is the repo
// facet's (repo/git-wire.test.ts pins its codecs).

import { expect, test } from "vitest";
import {
  projectScopedArtifacts,
  repoArtifactName,
  repoPathOf,
  ScopedArtifactRepoRpcTarget,
  type ArtifactRepoHandle,
  type ArtifactsNamespace,
} from "./cf-artifacts.ts";
import { settle } from "./test-support.ts";

// ── the mapping ── every itx surface speaks a repo's PATH; the Artifacts NAME is derived here alone.
test("repoArtifactName — the Artifacts repo a path is backed by: segments joined with `--`; the convention and any other path alike", () => {
  expect(repoArtifactName("/repos/config")).toBe("repos--config");
  expect(repoArtifactName("/vendor/lib")).toBe("vendor--lib");
  expect(repoArtifactName("/a/b.c/d_e-f")).toBe("a--b.c--d_e-f");
});
test("repoArtifactName — the Artifacts repo a path is backed by: injective: a segment may not contain `--`; the grammar and the root are refused", () => {
  expect(() => repoArtifactName("/repos/a--b")).toThrow(/without "--"/);
  expect(() => repoArtifactName("/repos/with space")).toThrow(/a path segment is/);
  expect(() => repoArtifactName("/")).toThrow(/root context is not a repo/);
  expect(() => repoArtifactName("/.hidden")).toThrow(/start with a letter or digit/);
});
test("repoArtifactName — the Artifacts repo a path is backed by: repoPathOf inverts it", () => {
  for (const path of ["/repos/config", "/vendor/lib", "/a/b.c/d_e-f", "/site"])
    expect(repoPathOf(repoArtifactName(path))).toBe(path);
});

// ── cfArtifacts ── `itx.cfArtifacts`, Cloudflare Artifacts project-scoped and addressed by PATH. Two
// isolation properties are what matter, and both are enforced HERE, not by the binding:
//   1. NAMES are forced under the caller's `${projectId}.` prefix — a `.` delimiter, because project
//      IDs are `[A-Za-z0-9_-]` (no `.`), so it cannot collide even when IDs contain `-` (a `--`
//      delimiter would: `a`+`b--x` == `a--b`+`x`). `list` is filtered to that prefix LOCALLY (the
//      binding returns EVERY project's repos) and answers in PATHS.
//   2. `get` returns the real handle's shape MINUS `fork` — whose runtime `fork(name)` (walked by the
//      itx dispatcher regardless of the narrowed type) takes an unprefixed name and escapes the wall.
// Pure over an injected namespace: no DO, no bindings, no network.

test("cfArtifacts speaks paths, prefixes the derived name with a '.' delimiter, and re-exposes the handle WITH remote() and WITHOUT fork", async () => {
  const { namespace, calls, forkCalled } = recordingNamespace();
  const a = scoped(namespace, "prj_a");

  // create is idempotent: the Artifacts repo is `prj_a.` + the path's `--`-joined segments.
  expect(await a.create("/repos/config")).toEqual({ created: true });
  expect(calls).toEqual([{ method: "create", name: "prj_a.repos--config" }]); // no read first
  expect(await a.create("/repos/config")).toEqual({ created: false });
  expect(calls.slice(1)).toEqual([
    { method: "create", name: "prj_a.repos--config" }, // taken…
    { method: "get", name: "prj_a.repos--config" }, // …by a repo that reads
  ]);

  const callsBeforeGet = calls.length;
  const repo = await a.get("/repos/config");
  expect(calls.length).toBe(callsBeforeGet); // each verb on the handle takes the binding's handle
  // The handle is an RpcTarget wrapper (so `get(path).createToken(...)` pipelines across /api), and it
  // re-exposes ONLY createToken, acting on the already-prefixed repo…
  expect(repo).toBeInstanceOf(ScopedArtifactRepoRpcTarget);
  expect(await repo.createToken("read", 60)).toMatchObject({
    plaintext: "read-prj_a.repos--config-60",
  });
  // …names the remote the facet's git client POSTs under (the platform knows account + namespace)…
  expect(await repo.remote()).toBe(
    "https://acct.artifacts.cloudflare.net/git/ns/prj_a.repos--config.git",
  );
  // …while fork is NOT reachable on it (its unprefixed name would escape the project wall).
  expect((repo as unknown as Record<string, unknown>).fork).toBeUndefined();
  expect(forkCalled()).toBe(false);

  expect(await a.delete("/repos/config")).toBe(true);
  expect(calls.at(-1)).toEqual({ method: "delete", name: "prj_a.repos--config" });

  // A path that cannot back an Artifacts repo is refused before the binding is touched.
  await expect(a.create("/repos/a--b")).rejects.toThrow(/without "--"/);
});

test("cfArtifacts delete answers false for a repo already gone, and surfaces any other failure", async () => {
  const { namespace } = recordingNamespace(["prj_a.repos--here"]);
  const a = scoped(namespace, "prj_a");
  expect(await a.delete("/repos/missing")).toBe(false);
  expect(await a.delete("/repos/here")).toBe(true);
  expect(await a.delete("/repos/here")).toBe(false);

  const failing = scoped(
    {
      ...namespace,
      delete: async () => {
        throw new Error("Artifacts unavailable (503)");
      },
    },
    "prj_a",
  );
  await expect(failing.delete("/repos/here")).rejects.toThrow(/unavailable/);
});

test("the '.' delimiter is collision-free for hyphenated project IDs; list filters locally and answers in paths", async () => {
  // A '--' delimiter would alias `prj_a` with `prj_a-b`. With '.', the prefixes `prj_a.` and
  // `prj_a-b.` are disjoint, so a raw (unfiltered) binding list is still split cleanly by project.
  const { namespace } = recordingNamespace(["prj_a.site", "prj_a-b.secret", "prj_a.repos--docs"]);

  const a = scoped(namespace, "prj_a");
  expect((await a.list()).repos.map((r) => r.path).sort()).toEqual(["/repos/docs", "/site"]); // NOT prj_a-b's

  const ab = scoped(namespace, "prj_a-b");
  expect((await ab.list()).repos.map((r) => r.path)).toEqual(["/secret"]);
});

test("every binding handle is released: create, createToken and remote leave none live", async () => {
  // A handle is a live Workers-RPC stub; one kept (the scoped repo held it, the create probe dropped
  // it) held the root's session to Artifacts, and the root, open until the next deploy (2026-09-23).
  const { namespace } = recordingNamespace();
  let opened = 0;
  let released = 0;
  const counting: ArtifactsNamespace = {
    ...namespace,
    get: async (name) => {
      const handle = await namespace.get(name); // a missing repo throws here: no handle to release
      opened++;
      return Object.assign(handle, { [Symbol.dispose]: () => released++ });
    },
  };
  const a = scoped(counting, "prj_a");
  await a.create("/repos/config"); // created: no probe
  await a.create("/repos/config"); // taken: the probe finds it
  const repo = await a.get("/repos/config");
  expect(await repo.createToken("write", 60)).toMatchObject({
    plaintext: "write-prj_a.repos--config-60",
  });
  expect(await repo.remote()).toMatch(/prj_a\.repos--config\.git$/);
  expect({ opened, released }).toEqual({ opened: 3, released: 3 }); // probe (found), createToken, remote
});

// A repo facet asks `get(path).remote()` and `get(path).createToken(…)` through its context: each is
// two dispatches (a mid-chain handle, packages/iterate/src/expression.ts), and each dispatch walks
// `get(path)` again. So `get` itself touches no binding, and each method opens exactly one handle.
test("get(path) touches no binding; remote() is one get and one info, createToken one get and one mint", async () => {
  const { namespace } = recordingNamespace(["prj_a.repos--config"]);
  const calls: string[] = [];
  const counting: ArtifactsNamespace = {
    ...namespace,
    get: async (name) => {
      calls.push("get");
      const handle = await namespace.get(name);
      return {
        ...handle,
        info: () => {
          calls.push("info");
          return handle.info();
        },
        createToken: (scope, ttlSeconds) => {
          calls.push("createToken");
          return handle.createToken(scope, ttlSeconds);
        },
      };
    },
  };
  const a = scoped(counting, "prj_a");
  await a.get("/repos/config");
  await a.get("/repos/config");
  expect(calls).toEqual([]);
  await (await a.get("/repos/config")).remote();
  expect(calls).toEqual(["get", "info"]);
  calls.length = 0;
  await (await a.get("/repos/config")).createToken("read", 60);
  expect(calls).toEqual(["get", "createToken"]);
  // A repo that does not exist fails at the method, with the binding's own error.
  await expect((await a.get("/repos/missing")).createToken("read", 60)).rejects.toThrow(
    /Repository not found/,
  );
  await expect((await a.get("/repos/missing")).remote()).rejects.toThrow(/Repository not found/);
});

// ── a name Artifacts is still deleting ── Artifacts deletes asynchronously (its REST delete answers
// 202): until the deletion lands, the name answers `create` "already exists" while `get` answers "not
// found" (2–5 s on the preview account, measured 2026-09-25). A create in that window, and one
// whose probe still reads the repo as it was, must end with a live repo or fail with its reason —
// never answer for a repo that is going, which a project's saga then records as `repo/created`.

test("a create right after a delete of the same name waits for the deletion to land, and ends with a live repo", async () => {
  const artifacts = deletingNamespace({ createsRefused: 2 }, ["prj_a.repos--config"]);
  const a = scoped(artifacts.namespace, "prj_a");
  expect(await a.delete("/repos/config")).toBe(true);
  expect(await settle(() => a.create("/repos/config"))).toMatchObject({
    value: { created: true },
    retries: [],
    logs: [
      {
        event: "cfartifacts.create-waited-for-taken-name",
        name: "prj_a.repos--config",
        rounds: 3,
        outcome: "created",
      },
    ],
  });
  expect(artifacts.live("prj_a.repos--config")).toBe(true);
  expect(artifacts.calls.map((call) => call.method)).toEqual([
    "delete",
    "create (taken)",
    "get", // not found: the deletion in flight
    "create (taken)",
    "get",
    "create",
  ]);
});

test("a create whose probe still reads the deleted repo creates it all the same", async () => {
  const artifacts = deletingNamespace({ createsRefused: 0, staleReads: true }, [
    "prj_a.repos--config",
  ]);
  const a = scoped(artifacts.namespace, "prj_a");
  expect(await a.delete("/repos/config")).toBe(true);
  expect(await (await a.get("/repos/config")).createToken("read", 60)).toMatchObject({
    plaintext: "read-prj_a.repos--config-60", // the stale read
  });
  expect(await a.create("/repos/config")).toEqual({ created: true });
  expect(artifacts.live("prj_a.repos--config")).toBe(true);
});

test("a name still taken past the bound is refused with its reason, and no repo is answered for", async () => {
  const artifacts = deletingNamespace({ createsRefused: Infinity }, ["prj_a.repos--config"]);
  const a = scoped(artifacts.namespace, "prj_a");
  await a.delete("/repos/config");
  expect(await settle(() => a.create("/repos/config"))).toMatchObject({
    error: {
      message: expect.stringMatching(
        /the Artifacts repo name prj_a\.repos--config is taken, yet no repo by that name has read in 19000 ms — a deletion of that name Artifacts has not finished/,
      ),
    },
    logs: [{ rounds: 7, waitedMs: 19_000, outcome: "still-taken" }],
  });
  expect(artifacts.live("prj_a.repos--config")).toBe(false);
});

// ── the binding's platform failure ── Artifacts API error 10400, "An internal error occurred.", which
// the binding answered to create, get, list and delete on and off for nine minutes on 2026-09-23
// (20:33–20:42 UTC), each call fine a moment later. Every verb retries it ONCE, a second later,
// logged; a second one surfaces.

test("after a platform failure, create retries a failed create, and a failed probe of a taken name", async () => {
  const create = flaky("create", [1]);
  expect(
    await settle(() => scoped(create.namespace, "prj_a").create("/repos/config")),
  ).toMatchObject({
    value: { created: true },
    retries: [
      {
        event: "cfartifacts.platform-failure-retry",
        name: "prj_a.repos--config",
        verb: "create",
        message: "An internal error occurred.",
      },
    ],
  });
  expect(create.calls.map((call) => call.method)).toEqual(["create (failed)", "create"]);

  const probe = flaky("get", [1], ["prj_a.repos--config"]);
  expect(
    await settle(() => scoped(probe.namespace, "prj_a").create("/repos/config")),
  ).toMatchObject({ value: { created: false }, retries: [{ verb: "probe" }] });
  expect(probe.calls.map((call) => call.method)).toEqual(["create", "get (failed)", "get"]);
});

test("after a platform failure, a create that landed all the same is not created twice", async () => {
  const recording = recordingNamespace();
  const landedThenFailed: ArtifactsNamespace = {
    ...recording.namespace,
    create: async (name) => {
      await recording.namespace.create(name);
      throw new Error("An internal error occurred.");
    },
  };
  expect(
    await settle(() => scoped(landedThenFailed, "prj_a").create("/repos/config")),
  ).toMatchObject({ value: { created: true }, retries: [{ verb: "create" }] });
  // the retry's create finds the name taken, and the probe reads the repo the first one made
  expect(recording.calls.map((call) => call.method)).toEqual(["create", "create", "get"]);
});

test("after a platform failure, a create that landed all the same answers created once it reads", async () => {
  // The create's 10400 came after it landed, and the landed repo did not read at once: the retry's
  // create finds the name taken, and the probe does not find it until it reads.
  const recording = recordingNamespace();
  let answered = 0;
  let unreadable = 2;
  const lagging: ArtifactsNamespace = {
    ...recording.namespace,
    create: async (name) => {
      const created = await recording.namespace.create(name);
      if (++answered === 1) throw new Error("An internal error occurred.");
      return created;
    },
    get: async (name) => {
      if (unreadable-- <= 0) return recording.namespace.get(name);
      recording.calls.push({ method: "get (not yet)", name });
      throw new Error("Repository not found (10200)");
    },
  };
  expect(await settle(() => scoped(lagging, "prj_a").create("/repos/config"))).toMatchObject({
    value: { created: true },
    retries: [{ verb: "create" }],
    logs: [{ event: "cfartifacts.create-waited-for-taken-name", rounds: 3, outcome: "reads" }],
  });
  expect(recording.calls.map((call) => call.method)).toEqual([
    "create",
    "create",
    "get (not yet)",
    "create",
    "get (not yet)",
    "create",
    "get",
  ]);
});

test("a create answered anything but 'already exists' surfaces, and no one retries", async () => {
  const refusing: ArtifactsNamespace = {
    ...recordingNamespace().namespace,
    create: async () => {
      throw new Error("Artifacts unavailable (503)");
    },
  };
  expect(await settle(() => scoped(refusing, "prj_a").create("/repos/config"))).toMatchObject({
    error: { message: "Artifacts unavailable (503)" },
    retries: [],
  });
});

test("after a platform failure, remote, createToken, list and delete each answer on their retry", async () => {
  const get = flaky("get", [1], ["prj_a.repos--config"]);
  expect(
    await settle(async () => (await scoped(get.namespace, "prj_a").get("/repos/config")).remote()),
  ).toMatchObject({
    value: "https://acct.artifacts.cloudflare.net/git/ns/prj_a.repos--config.git",
    retries: [{ verb: "remote" }],
  });

  const token = flaky("get", [1], ["prj_a.repos--config"]);
  expect(
    await settle(async () =>
      (await scoped(token.namespace, "prj_a").get("/repos/config")).createToken("write", 60),
    ),
  ).toMatchObject({
    value: { plaintext: "write-prj_a.repos--config-60" },
    retries: [{ verb: "createToken" }],
  });

  const list = flaky("list", [1], ["prj_a.site"]);
  expect(await settle(() => scoped(list.namespace, "prj_a").list())).toMatchObject({
    value: { repos: [{ path: "/site" }] },
    retries: [{ verb: "list" }],
  });

  const del = flaky("delete", [1], ["prj_a.site"]);
  expect(await settle(() => scoped(del.namespace, "prj_a").delete("/site"))).toMatchObject({
    value: true,
    retries: [{ verb: "delete" }],
  });
});

test("after a platform failure, a delete that landed all the same answers false on its retry: already gone", async () => {
  const recording = recordingNamespace(["prj_a.site"]);
  const landedThenFailed: ArtifactsNamespace = {
    ...recording.namespace,
    delete: async (name) => {
      await recording.namespace.delete(name);
      throw new Error("An internal error occurred.");
    },
  };
  expect(await settle(() => scoped(landedThenFailed, "prj_a").delete("/site"))).toMatchObject({
    value: false,
    retries: [{ verb: "delete" }],
  });
});

test("the platform-failure retry is bounded: a second one surfaces, and any other failure is never retried", async () => {
  const twice = flaky("list", [1, 2]);
  expect(await settle(() => scoped(twice.namespace, "prj_a").list())).toMatchObject({
    error: { message: "An internal error occurred." },
    retries: [{ verb: "list" }],
  });

  const unavailable: ArtifactsNamespace = {
    ...recordingNamespace().namespace,
    list: async () => {
      throw new Error("Artifacts unavailable (503)");
    },
  };
  expect(await settle(() => scoped(unavailable, "prj_a").list())).toMatchObject({
    error: { message: "Artifacts unavailable (503)" },
    retries: [],
  });
});

/** The recording namespace, with `method` failing as the binding did on the calls numbered
 *  `failingCalls` (from 1). */
function flaky(method: keyof ArtifactsNamespace, failingCalls: number[], existing: string[] = []) {
  const recording = recordingNamespace(existing);
  let call = 0;
  // one method of the recording namespace, called through with its own arguments
  const real = recording.namespace[method] as (...args: unknown[]) => Promise<unknown>;
  // the recording namespace with that one method wrapped: the same shape
  const namespace = {
    ...recording.namespace,
    [method]: async (...args: unknown[]) => {
      if (failingCalls.includes(++call)) {
        recording.calls.push({ method: `${method} (failed)`, name: String(args[0] ?? "*") });
        throw new Error("An internal error occurred.");
      }
      return real(...args);
    },
  } as ArtifactsNamespace;
  return { ...recording, namespace };
}

/** Artifacts' asynchronous delete over the recording namespace: `delete` answers at once and the
 *  repo stops reading, but its name stays taken — `create` answers "already exists" — for the next
 *  `createsRefused` creates, until the deletion lands. With `staleReads`, `get` still reads the
 *  deleted repo meanwhile: a probe that answers for the repo as it was. */
function deletingNamespace(
  options: { createsRefused: number; staleReads?: boolean },
  existing: string[],
) {
  const recording = recordingNamespace(existing);
  const deleting = new Map<string, number>(); // name → creates still refused before the deletion lands
  const namespace: ArtifactsNamespace = {
    ...recording.namespace,
    delete: async (name) => {
      const deleted = await recording.namespace.delete(name);
      deleting.set(name, options.createsRefused);
      return deleted;
    },
    create: async (name) => {
      const refused = deleting.get(name) ?? 0;
      if (refused > 0) {
        deleting.set(name, refused - 1);
        recording.calls.push({ method: "create (taken)", name });
        throw new Error(`repo already exists: ${name}`);
      }
      deleting.delete(name);
      return recording.namespace.create(name);
    },
    get: async (name) => {
      if (!options.staleReads || !deleting.has(name)) return recording.namespace.get(name);
      recording.calls.push({ method: "get (stale)", name });
      return {
        info: async () => ({ remote: `https://acct.artifacts.cloudflare.net/git/ns/${name}.git` }),
        createToken: async (scope: "read" | "write", ttlSeconds: number) => ({
          plaintext: `${scope}-${name}-${ttlSeconds}`,
        }),
      } as unknown as ArtifactRepoHandle;
    },
  };
  return { ...recording, namespace };
}

function recordingNamespace(existing: string[] = []) {
  const calls: { method: string; name: string }[] = [];
  const repos = new Set(existing);
  let forkCalled = false;
  const namespace: ArtifactsNamespace = {
    create: async (name) => {
      calls.push({ method: "create", name });
      // the binding's answer to a name that is taken
      if (repos.has(name)) throw new Error(`repo already exists: ${name}`);
      repos.add(name);
      return { token: `tok-${name}` };
    },
    get: async (name) => {
      calls.push({ method: "get", name });
      // The binding's "no such repo" (API error 10200) — the one signal a read maps to "no files".
      if (!repos.has(name)) throw new Error("Repository not found (10200)");
      // A real-shaped handle that ALSO carries the UNSAFE `fork(dest)` — `get` must re-expose
      // `createToken` but NEVER this method.
      return {
        // the binding names the remote itself (account and namespace baked in) — `info()`, a method:
        // the real handle is an RPC stub
        info: async () => ({ remote: `https://acct.artifacts.cloudflare.net/git/ns/${name}.git` }),
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
      return { repos: [...repos].map((name) => ({ name })) };
    },
    delete: async (name) => {
      calls.push({ method: "delete", name });
      // The binding's delete of a missing repo throws the same "not found" (API error 10200).
      if (!repos.delete(name)) throw new Error("Repository not found (10200)");
      return true;
    },
  };
  return {
    namespace,
    calls,
    forkCalled: () => forkCalled,
    live: (name: string) => repos.has(name),
  };
}

const scoped = (namespace: ArtifactsNamespace, projectId: string) =>
  projectScopedArtifacts({ namespace, projectId });
