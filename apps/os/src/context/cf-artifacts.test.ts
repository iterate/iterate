// context/cf-artifacts.test.ts — `itx.cfArtifacts`'s unit pins: the binding proxy (project-scoped, BY PATH,
// pure over an injected namespace) and the path → Artifacts-name mapping. Git itself is the repo
// facet's (src/repo/git-wire.test.ts pins its codecs).

import { describe, expect, test } from "vitest";
import {
  projectScopedArtifacts,
  repoArtifactName,
  repoPathOf,
  ScopedArtifactRepoRpcTarget,
  type ArtifactRepoHandle,
  type ArtifactsNamespace,
} from "./cf-artifacts.ts";

// ── the mapping ── every itx surface speaks a repo's PATH; the Artifacts NAME is derived here alone.
describe("repoArtifactName — the Artifacts repo a path is backed by", () => {
  test("segments joined with `--`; the convention and any other path alike", () => {
    expect(repoArtifactName("/repos/config")).toBe("repos--config");
    expect(repoArtifactName("/vendor/lib")).toBe("vendor--lib");
    expect(repoArtifactName("/a/b.c/d_e-f")).toBe("a--b.c--d_e-f");
  });
  test("injective: a segment may not contain `--`; the grammar and the root are refused", () => {
    expect(() => repoArtifactName("/repos/a--b")).toThrow(/without "--"/);
    expect(() => repoArtifactName("/repos/with space")).toThrow(/a path segment is/);
    expect(() => repoArtifactName("/")).toThrow(/root context is not a repo/);
    expect(() => repoArtifactName("/.hidden")).toThrow(/start with a letter or digit/);
  });
  test("repoPathOf inverts it", () => {
    for (const path of ["/repos/config", "/vendor/lib", "/a/b.c/d_e-f", "/site"])
      expect(repoPathOf(repoArtifactName(path))).toBe(path);
  });
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

function recordingNamespace(existing: string[] = []) {
  const calls: { method: string; name: string }[] = [];
  const repos = new Set(existing);
  let forkCalled = false;
  const namespace: ArtifactsNamespace = {
    create: async (name) => {
      calls.push({ method: "create", name });
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
  return { namespace, calls, forkCalled: () => forkCalled };
}

const scoped = (namespace: ArtifactsNamespace, projectId: string) =>
  projectScopedArtifacts({ namespace, projectId });

test("cfArtifacts speaks paths, prefixes the derived name with a '.' delimiter, and re-exposes the handle WITH remote() and WITHOUT fork", async () => {
  const { namespace, calls, forkCalled } = recordingNamespace();
  const a = scoped(namespace, "prj_a");

  // create is idempotent: the Artifacts repo is `prj_a.` + the path's `--`-joined segments.
  expect(await a.create("/repos/config")).toEqual({ created: true });
  expect(calls.at(-1)).toEqual({ method: "create", name: "prj_a.repos--config" });
  expect(await a.create("/repos/config")).toEqual({ created: false });
  expect(calls.at(-1)).toEqual({ method: "get", name: "prj_a.repos--config" }); // found — no create

  const repo = await a.get("/repos/config");
  expect(calls.at(-1)).toEqual({ method: "get", name: "prj_a.repos--config" });
  // The handle is an RpcTarget wrapper (so `get(path).createToken(...)` pipelines across /api), and it
  // re-exposes ONLY createToken, acting on the already-prefixed repo…
  expect(repo).toBeInstanceOf(ScopedArtifactRepoRpcTarget);
  expect((await repo.createToken("read", 60)).plaintext).toBe("read-prj_a.repos--config-60");
  // …names the remote the facet's git client POSTs under (the platform knows account + namespace)…
  expect(repo.remote()).toBe(
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

test("every binding handle is released: create, get and createToken leave none live", async () => {
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
  await a.create("/repos/config"); // the probe: not found, then create
  await a.create("/repos/config"); // the probe: found
  const repo = await a.get("/repos/config");
  expect((await repo.createToken("write", 60)).plaintext).toBe("write-prj_a.repos--config-60");
  expect({ opened, released }).toEqual({ opened: 3, released: 3 }); // probe (found), get, createToken
});
