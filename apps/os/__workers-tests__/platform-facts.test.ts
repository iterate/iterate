// __workers-tests__/platform-facts.test.ts — ONLY THE PLATFORM APPENDS ITS FACTS (caller.ts
// `PLATFORM_FACT_TYPES`): a person's append of one, loaded code's, or a schedule set to append one
// is FORBIDDEN at the append boundary, so a reader — a config repo's `processEvent` — trusts such
// an event by its type alone. The platform's own lands, stamped `source.platform`.
import { expect, test } from "vitest";
import { PLATFORM_FACT_TYPES } from "../src/caller.ts";
import { readLog, refused, stub } from "./support.ts";

/** A member signed in at the edge: what a session's call carries. */
const MEMBER = { actor: "usr_platform_facts", email: "member@example.test" };

test("a member's append of each platform fact, loaded code's, and a schedule set to append one are FORBIDDEN; the platform's own lands stamped as the platform's", async () => {
  const ctx = `prj_platform_facts_${crypto.randomUUID().slice(0, 8)}`;
  for (const type of PLATFORM_FACT_TYPES) {
    const event = { type, payload: {} };
    await refused(
      () => stub(ctx).invoke(["itx", ["append", event]], [], { principal: MEMBER }),
      "FORBIDDEN",
      /is the platform's own fact/,
    );
    await refused(
      () => stub(ctx).invoke(["itx", ["append", event]], [], { principal: null, app: true }),
      "FORBIDDEN",
    );
    await refused(
      () =>
        stub(ctx).invoke(
          [
            "itx",
            "schedules",
            ["set", { key: "forged", when: { afterMs: 60_000 }, events: [event] }],
          ],
          [],
          { principal: MEMBER },
        ),
      "FORBIDDEN",
    );
  }
  expect((await readLog(ctx)).filter(({ type }) => PLATFORM_FACT_TYPES.has(type))).toEqual([]);
  await stub(ctx).invoke(
    [
      "itx",
      "builtins",
      [
        "append",
        {
          type: "events.iterate.com/project/worker-update-failed",
          payload: { commitOid: "c", generation: 1, error: "e" },
        },
      ],
    ],
    [],
    { principal: null, platform: true },
  );
  expect((await readLog(ctx)).at(-1)).toMatchObject({
    type: "events.iterate.com/project/worker-update-failed",
    source: { platform: true },
  });
});
