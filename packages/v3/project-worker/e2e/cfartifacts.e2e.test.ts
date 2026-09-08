// cfartifacts.e2e.test.ts — `itx.cfArtifacts` against the REAL Cloudflare Artifacts binding on the
// DEPLOYED worker (env.ARTIFACTS → the `project-worker-repos` namespace). Proves the two things the
// unit test (src/context/built-ins-artifacts.test.ts) can only prove over a fake: the binding is
// actually wired, and the project-scoping (prefix + local list filter) holds end-to-end across /api.
//
// NOTE the get→createToken CHAIN: `get` returns a plain object whose `createToken` is a closure, so it
// must be pipelined server-side in ONE expression — awaiting `get` alone would try to send the closure
// over the wire. Every repo created here is deleted in a `finally` (the project-teardown path).

import { expect, test } from "vitest";
import { freshCtx, openItx } from "./support/client.ts";

const rnd = (): string => Math.random().toString(36).slice(2, 8);

test("cfArtifacts create/get/list/delete against the real binding, project-scoped", async () => {
  const a = openItx(freshCtx("cfa"));
  const repo = `smoke-${rnd()}`;

  // create → a real repo (stored as `<projectId>.<repo>` in the namespace); returns a git token.
  const created = await a.cfArtifacts.create(repo);
  expect(typeof created.token).toBe("string");
  expect(created.token.length).toBeGreaterThan(0);

  try {
    // list → THIS project's repos, prefix stripped: our repo shows by its bare name.
    const listed = await a.cfArtifacts.list();
    expect(listed.repos.map((r: { name: string }) => r.name)).toContain(repo);

    // get(repo).createToken(...) pipelined server-side → a real git credential; no closure on the wire.
    const tok = await a.cfArtifacts.get(repo).createToken("read", 300);
    expect(typeof tok.plaintext).toBe("string");
    expect(tok.plaintext.length).toBeGreaterThan(0);
  } finally {
    expect(await a.cfArtifacts.delete(repo)).toBe(true);
  }

  // after delete, the repo is gone from this project's list.
  const after = await a.cfArtifacts.list();
  expect(after.repos.map((r: { name: string }) => r.name)).not.toContain(repo);
});

test("cfArtifacts isolation: one project never sees another's repos", async () => {
  const a = openItx(freshCtx("cfaIsoA"));
  const b = openItx(freshCtx("cfaIsoB"));
  const repo = `iso-${rnd()}`;

  await a.cfArtifacts.create(repo);
  try {
    // b lists its OWN repos — a's repo lives under a's prefix and is filtered out.
    const bList = await b.cfArtifacts.list();
    expect(bList.repos.map((r: { name: string }) => r.name)).not.toContain(repo);
  } finally {
    await a.cfArtifacts.delete(repo);
  }
});
