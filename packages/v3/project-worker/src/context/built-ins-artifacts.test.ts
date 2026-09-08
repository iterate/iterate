// built-ins-artifacts.test.ts — `itx.cfArtifacts`, the RAW Cloudflare Artifacts binding, project-
// scoped. Two isolation properties are what matter, and both are enforced HERE, not by the binding:
//   1. NAMES are forced under the caller's `${projectId}.` prefix — a `.` delimiter, because project
//      IDs are `[A-Za-z0-9_-]` (no `.`), so it cannot collide even when IDs contain `-` (a `--`
//      delimiter would: `a`+`b--x` == `a--b`+`x`). `list` is filtered to that prefix LOCALLY (the
//      binding returns EVERY project's repos).
//   2. The scope returns ONLY plain data — never the repo HANDLE, whose runtime `fork(name)` (walked
//      by the itx dispatcher regardless of the narrowed type) would escape the prefix.
// Pure over an injected namespace: no DO, no bindings, no network.

import { expect, test } from "vitest";
import {
  projectScopedArtifacts,
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
      // A handle that ALSO carries the UNSAFE `fork(dest)` — the escape hatch must never hand it out.
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
  };
  return { namespace, calls, forkCalled: () => forkCalled };
}

test("cfArtifacts prefixes with a '.' delimiter and mints tokens WITHOUT exposing the repo handle", async () => {
  const { namespace, calls, forkCalled } = recordingNamespace();
  const a = projectScopedArtifacts(namespace, "prj_a");

  expect((await a.create("config")).token).toBe("tok-prj_a.config");
  expect(calls.at(-1)).toEqual({ method: "create", name: "prj_a.config" }); // prefixed on the way in

  const minted = await a.token("config", "read", 60);
  expect(calls.at(-1)).toEqual({ method: "get", name: "prj_a.config" });
  expect(minted).toEqual({ token: "read-prj_a.config-60" }); // ONLY the token string leaves…
  expect(Object.keys(minted)).toEqual(["token"]); // …not the handle, so its fork() cannot be reached
  expect(forkCalled()).toBe(false);
  // There is no handle-returning door on the surface at all.
  expect((a as Record<string, unknown>).get).toBeUndefined();
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
