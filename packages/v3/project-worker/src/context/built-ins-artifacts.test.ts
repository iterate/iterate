// built-ins-artifacts.test.ts — `itx.cfArtifacts`, the RAW Cloudflare Artifacts binding, project-
// scoped and SHAPED like the real binding (create/get/list return the real shapes). Two isolation
// properties are what matter, and both are enforced HERE, not by the binding:
//   1. NAMES are forced under the caller's `${projectId}.` prefix — a `.` delimiter, because project
//      IDs are `[A-Za-z0-9_-]` (no `.`), so it cannot collide even when IDs contain `-` (a `--`
//      delimiter would: `a`+`b--x` == `a--b`+`x`). `list` is filtered to that prefix LOCALLY (the
//      binding returns EVERY project's repos).
//   2. `get` returns the real handle's shape MINUS `fork` — whose runtime `fork(name)` (walked by the
//      itx dispatcher regardless of the narrowed type) takes an unprefixed name and escapes the wall.
// Pure over an injected namespace: no DO, no bindings, no network.

import { expect, test } from "vitest";
import {
  projectScopedArtifacts,
  ScopedArtifactRepo,
  type ArtifactRepoHandle,
  type ArtifactsNamespace,
} from "./built-ins.ts";

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
      // A real-shaped handle that ALSO carries the UNSAFE `fork(dest)` — `get` must re-expose the
      // safe fields (`lastPushAt`, `createToken`) but NEVER this method.
      return {
        lastPushAt: `pushed-${name}`,
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
