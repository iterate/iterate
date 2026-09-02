import { expect, test } from "vitest";
import { triageArtifactsRepoPage } from "./artifacts-gc.ts";

// Repo names as the app creates them: `${projectId}--${base64url(path)}`
// (RepoArtifactNameCodec). "/config" base64url-encodes to "L2NvbmZpZw".
const name = (projectId: string) => `${projectId}--${Buffer.from("/config").toString("base64url")}`;

test("deletes old orphans, keeps live projects, stops at the age cutoff", () => {
  const result = triageArtifactsRepoPage({
    repos: [
      { name: name("prj_dead1"), created_at: "2026-01-01T00:00:00Z" },
      { name: name("prj_alive"), created_at: "2026-02-01T00:00:00Z" },
      { name: name("prj_dead2"), created_at: "2026-03-01T00:00:00Z" },
      // oldest-first listing: everything from the first repo past the cutoff
      // on is younger still, so triage ends the whole sweep there
      { name: name("prj_young"), created_at: "2026-08-31T00:00:00Z" },
      { name: name("prj_dead3"), created_at: "2026-09-01T00:00:00Z" },
    ],
    liveProjectIds: new Set(["prj_alive"]),
    cutoffIso: "2026-08-30T00:00:00Z",
    protectGlobalRepos: false,
  });
  expect(result).toMatchObject({
    deletable: [name("prj_dead1"), name("prj_dead2")],
    skippedLive: [name("prj_alive")],
    reachedCutoff: true,
  });
});

test("repos with no recognizable project id are never deleted", () => {
  const result = triageArtifactsRepoPage({
    repos: [
      { name: "iterate-config-base", created_at: "2026-01-01T00:00:00Z" },
      { name: "repo-5f5f6e756c6c5f5f", created_at: "2026-01-01T00:00:00Z" },
    ],
    liveProjectIds: new Set(),
    cutoffIso: "2026-08-30T00:00:00Z",
    protectGlobalRepos: false,
  });
  expect(result).toMatchObject({
    deletable: [],
    skippedForeign: ["iterate-config-base", "repo-5f5f6e756c6c5f5f"],
  });
});

test("legacy-named repos (literal suffix, pre-codec) still follow their project id", () => {
  const result = triageArtifactsRepoPage({
    repos: [
      { name: "prj_2acd3201c01844e2--iterate-config", created_at: "2026-01-01T00:00:00Z" },
      { name: "prj_3d195e6120c14e18--iterate-config", created_at: "2026-01-01T00:00:00Z" },
      {
        name: "proj__os__01kry9v2fxend9egy4t4--iterate-config",
        created_at: "2026-01-01T00:00:00Z",
      },
      { name: "proj__os__01ks16y7x3fvhsysnvsg--e2e-2c1f6a50", created_at: "2026-01-01T00:00:00Z" },
    ],
    liveProjectIds: new Set(["prj_3d195e6120c14e18", "proj__os__01ks16y7x3fvhsysnvsg"]),
    cutoffIso: "2026-08-30T00:00:00Z",
    protectGlobalRepos: false,
  });
  expect(result).toMatchObject({
    deletable: [
      "prj_2acd3201c01844e2--iterate-config",
      "proj__os__01kry9v2fxend9egy4t4--iterate-config",
    ],
    skippedLive: [
      "prj_3d195e6120c14e18--iterate-config",
      "proj__os__01ks16y7x3fvhsysnvsg--e2e-2c1f6a50",
    ],
  });
});

test("repo-<hex> names decode to <id>:<path> and follow the decoded id", () => {
  const hexName = (decoded: string) => `repo-${Buffer.from(decoded).toString("hex")}`;
  const result = triageArtifactsRepoPage({
    repos: [
      // "__null__:<path>" = global scope; deletable off prd like any global repo
      { name: hexName("__null__:/repos/iterate-config-base"), created_at: "2026-01-01T00:00:00Z" },
      { name: hexName("prj_dead12345678:/repos/config"), created_at: "2026-01-01T00:00:00Z" },
      { name: hexName("prj_alive1234567:/repos/config"), created_at: "2026-01-01T00:00:00Z" },
      // hex that decodes to garbage (no separator / non-printable) stays untouched
      { name: "repo-00ff00ff", created_at: "2026-01-01T00:00:00Z" },
    ],
    liveProjectIds: new Set(["prj_alive1234567"]),
    cutoffIso: "2026-08-30T00:00:00Z",
    protectGlobalRepos: false,
  });
  expect(result).toMatchObject({
    deletable: [
      hexName("__null__:/repos/iterate-config-base"),
      hexName("prj_dead12345678:/repos/config"),
    ],
    skippedLive: [hexName("prj_alive1234567:/repos/config")],
    skippedForeign: ["repo-00ff00ff"],
  });
});

test("global-scope repos have no owning project: deletable on preview, kept on prd", () => {
  const globalRepos = [{ name: name("global"), created_at: "2026-01-01T00:00:00Z" }];
  const base = { liveProjectIds: new Set<string>(), cutoffIso: "2026-08-30T00:00:00Z" };

  expect(
    triageArtifactsRepoPage({ repos: globalRepos, ...base, protectGlobalRepos: false }),
  ).toMatchObject({ deletable: [name("global")] });

  expect(
    triageArtifactsRepoPage({ repos: globalRepos, ...base, protectGlobalRepos: true }),
  ).toMatchObject({ deletable: [], skippedGlobal: [name("global")] });
});
