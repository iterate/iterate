// provenance.e2e.test.ts — ONE PROJECT, ONE TRUST BOUNDARY: anyone in a project may append anything
// anywhere, nothing forges where an event came from, and a reader decides whom it listens to. The
// platform replaces every event's `source` whole as it commits (src/caller.ts `stampCaller`): the
// context whose code or session wrote it (`origin`), the member (`principal`), and whether the
// platform vouches for it (`platform`). A processor acts on the events its contract's `trust`
// admits (iterate/stream/processor `admits`): by default the platform's, a member's, and those
// written by code at its context or above it.
import { createFailing } from "@iterate-com/shared/test-support/failing-test";
import { expect, test } from "vitest";
import { collector, freshCtx, openItx, rejection, until } from "./support/client.ts";

/** Every field a writer might claim about itself. */
const FORGED = {
  origin: "/elsewhere",
  principal: { actor: "forged" },
  grant: "grant_forged",
  platform: true,
  processor: { slug: "p", version: "1" },
  schedule: { key: "k", scheduledAtOffset: 1, at: "2026-01-01T00:00:00.000Z" },
};

test("nothing forges its own source: a session's and a script's `source` is replaced whole by the platform's stamp", async () => {
  const root = openItx(freshCtx("provenance-forged"));
  const [bySession] = await root.append({ type: "probe/forged", source: FORGED });
  expect(bySession.source, "a forged source should never survive a session's append").toEqual({
    origin: "/",
    principal: { actor: "admin" },
  });
  const byScript = await root
    .cd("/p")
    .builtins.run(
      `async (itx) => (await itx.append({ type: "probe/forged", source: ${JSON.stringify(FORGED)} }))[0].source`,
    );
  expect(byScript, "a forged source should never survive a script's append").toEqual({
    origin: "/p",
  });
});

createFailing(test, /goes down only/)(
  "a lifecycle fact from a writer the entity does not trust lands, stamped with its writer, and changes nothing",
  async () => {
    const root = openItx(freshCtx("provenance-untrusted-lifecycle"));
    await root.workspaces.create("/w");
    // Loaded code at /x, beside /w: its delete request is a message the workspace does not hear.
    const requested = (await root
      .cd("/x")
      .builtins.run(
        "async (itx) => (await itx.cd('/w').append({ type: 'events.iterate.com/workspace/delete-requested', payload: {} }))[0]",
      )) as { offset: number; source: unknown };
    expect(requested.source).toEqual({ origin: "/x" });
    const workspace = root.cd("/w").facets.get("workspace");
    await workspace.waitUntilProcessed({ offset: requested.offset });
    expect(
      (await workspace.snapshot()).state.deletion,
      "a delete request from beside the workspace should change nothing",
    ).toBeNull();
    expect(await root.workspaces.list()).toEqual([{ path: "/w", createdAt: expect.any(String) }]);
  },
);

test("a jailed context's writes are visibly the jail's: its one outward channel lands stamped with the jail", async () => {
  const root = openItx(freshCtx("provenance-jail"));
  const jail = root.cd("/jail");
  // A bare null, then the one grant: what the jail says goes to /inbox.
  await jail.provide("itx", null);
  await jail.provide("itx.tell", "itx.builtins.cd('/inbox').append");
  const told = (await jail.builtins.run(
    "async (itx) => (await itx.tell({ type: 'note/told', payload: { text: 'let me out' } }))[0]",
  )) as { source?: unknown; path: string };
  expect(told.path).toBe("/inbox");
  expect(told.source, "the jail's writes should carry the jail as their origin").toEqual({
    origin: "/jail",
  });
});

test("the platform's own records are the platform's: a settlement a writer appends is refused, so no one settles a run it did not execute", async () => {
  const root = openItx(freshCtx("provenance-platform-only"));
  const [requested] = await root.append({
    type: "events.iterate.com/itx/run-requested",
    payload: { code: "async () => 1" },
  });
  expect(
    (
      await rejection(
        root.append({
          type: "events.iterate.com/itx/run-settled",
          payload: {
            requestOffset: requested.offset,
            settlement: { status: "succeeded", result: 2 },
          },
        }),
      )
    ).message,
  ).toMatch(/is the platform's own record/);
});

test("a raw reader hears the trusted writers by default; `from: 'anyone'` hears every writer in the project", async () => {
  const root = openItx(freshCtx("provenance-raw-reader"));
  await root.workspaces.create("/w");
  const w = root.cd("/w");
  const trusted = collector();
  const everyone = collector();
  using _trusted = await w.subscribe({ target: trusted.fn });
  using _everyone = await w.subscribe({ target: everyone.fn, from: "anyone" });
  // /x is linked to the root, and its code reaches the workspace's typed append from beside it.
  const x = root.cd("/x");
  await x.provide("itx", "itx.builtins.cd('/')");
  const [fromBeside] = (await x.builtins.run(
    "async (itx) => itx.workspaces.get('/w').append({ type: 'events.iterate.com/workspace/delete-requested', payload: {} })",
  )) as { offset: number; source?: unknown }[];
  expect(fromBeside!.source).toEqual({ origin: "/x" });
  const [fromMember] = await w.append({ type: "note/by-member" });
  for (const reader of [trusted, everyone])
    await until("the member's note reaches the reader", async () =>
      reader.offsets().includes(fromMember.offset) ? true : undefined,
    );
  expect(everyone.offsets()).toContain(fromBeside!.offset);
  expect(trusted.offsets()).not.toContain(fromBeside!.offset);
  // and the workspace itself did not listen: it stands
  expect(await root.workspaces.list()).toEqual([{ path: "/w", createdAt: expect.any(String) }]);
});
