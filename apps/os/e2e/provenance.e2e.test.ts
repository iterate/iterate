// provenance.e2e.test.ts — ONE PROJECT, ONE TRUST BOUNDARY: anyone in a project may append anything
// anywhere, nothing forges where an event came from, and a reader decides whom it listens to. The
// platform replaces every event's `source` whole as it commits (src/caller.ts `stampCaller`): the
// context whose code or session wrote it (`origin`), the member (`principal`), and whether the
// platform vouches for it (`platform`). A processor acts on the events its contract's `trust`
// admits (iterate/stream/processor `admits`): by default the platform's, a member's, and those
// written by code at its context or above it.
import { createFailing } from "@iterate-com/shared/test-support/failing-test";
import { expect, test } from "vitest";
import { freshCtx, openItx } from "./support/client.ts";

/** Every field a writer might claim about itself. */
const FORGED = {
  origin: "/elsewhere",
  principal: { actor: "forged" },
  grant: "grant_forged",
  platform: true,
  processor: { slug: "p", version: "1" },
  schedule: { key: "k", scheduledAtOffset: 1, at: "2026-01-01T00:00:00.000Z" },
};

createFailing(test, /a forged source should never survive/)(
  "nothing forges its own source: a session's and a script's `source` is replaced whole by the platform's stamp",
  async () => {
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
  },
);

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

createFailing(test, /the jail's writes should carry the jail as their origin/)(
  "a jailed context's writes are visibly the jail's: its one outward channel lands stamped with the jail",
  async () => {
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
  },
);
