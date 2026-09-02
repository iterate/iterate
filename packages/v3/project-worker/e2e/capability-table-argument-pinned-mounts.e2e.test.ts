// capability-table-argument-pinned-mounts.e2e.test.ts — a capability path may PIN literal args on a call
// step (routing.ts rule 1): `itx.ai.run('special')` is a more specific mount than `itx.ai.run`, matched
// by structural equality of the leading args and CONSUMED by the match (partial application) — the
// target sees only the unpinned args. Through the real DO: provide, route, a live value under a
// pinned key, revoke by the pinned spelling.

import { expect, test } from "vitest";
import { freshCtx, openItx } from "./support/client.ts";

test("itx.ai.run('special') routes past the plain itx.ai.run mount; pinned args are consumed; a live value can sit under a pinned key", async () => {
  const ctx = freshCtx("pinned");
  const itx = openItx(ctx);
  await itx.provide("itx.ai.run", "itx.kv.get"); // the plain mount: itx.ai.run(k) → itx.kv.get(k)
  await itx.provide("itx.ai.run('special')", "itx.whoami"); // pinned: itx.ai.run('special') → itx.whoami()
  await itx.invokeCapability("itx.kv.put('other', 'from-kv')");
  expect(await itx.invokeCapability("itx.ai.run('special')")).toMatchObject({ projectId: ctx });
  expect(await itx.invokeCapability("itx.ai.run('other')")).toBe("from-kv");
  // a live capnweb value under a pinned key — the pinned arg never reaches it
  await itx.provide(
    "itx.ai.run('live')",
    (...unpinned: unknown[]) => `live:${JSON.stringify(unpinned)}`,
  );
  expect(await itx.invokeCapability("itx.ai.run('live', 7)")).toBe("live:[7]");
  // the rows carry structured paths; revoke by the canonical pinned spelling pops exactly that mount
  const snap: any = await itx.invokeCapability("itx.facets.get('core').snapshot()");
  expect(snap.state.mounts.map((m: any) => m.path)).toEqual(
    expect.arrayContaining([
      ["itx", "ai", ["run", "special"]],
      ["itx", "ai", ["run", "live"]],
    ]),
  );
  await itx.revoke("itx.ai.run('special')");
  expect(await itx.invokeCapability("itx.ai.run('special')")).toBeNull(); // back to the plain mount → kv.get
});
