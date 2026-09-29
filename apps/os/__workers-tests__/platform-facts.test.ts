// __workers-tests__/platform-facts.test.ts — ONLY THE PLATFORM WRITES ITS OWN (caller.ts
// `refuseNonPlatformWrites`, whose unit table owns the list): a platform fact and a row on the config
// pointer — a member's append of one, loaded code's, an unstamped raw append, or a schedule set to
// append one — are FORBIDDEN at the append boundary, so a reader trusts it by its type alone. The
// platform's own lands, stamped `source.platform`.
import { expect, test } from "vitest";
import { readLog, refused, stub } from "./support.ts";

/** A member signed in at the edge: what a session's call carries. */
const MEMBER = { actor: "usr_platform_facts", email: "member@example.test" };

test.for([
  { name: "a platform fact", event: { type: "events.iterate.com/email/received", payload: {} } },
  { name: "the config pointer", event: pointer("itx.config", ["itx", ["cd", "/c"], "w"]) },
  { name: "a mask on the config pointer", event: pointer("itx.config", null) },
  {
    name: "the config pointer's deliverEvent",
    event: pointer("itx.config.deliverEvent", ["itx", ["cd", "/c"], "w"]),
  },
])(
  "$name from anyone but the platform is FORBIDDEN: a member's, loaded code's, a raw append's and a schedule's; the log does not move",
  async ({ event }) => {
    const ctx = `prj_platform_writes_${crypto.randomUUID().slice(0, 8)}`;
    const head = (await readLog(ctx)).length;
    await refused(
      () => stub(ctx).invoke(["itx", ["append", event]], [], { principal: MEMBER }),
      "FORBIDDEN",
      /is the platform's own fact|only the platform's publication writes it/,
    );
    await refused(
      () => stub(ctx).invoke(["itx", ["append", event]], [], { principal: null, app: true }),
      "FORBIDDEN",
    );
    await refused(() => stub(ctx).append(event), "FORBIDDEN");
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
    expect(await readLog(ctx)).toHaveLength(head);
  },
);

test("the platform's own fact lands, stamped as the platform's", async () => {
  const ctx = `prj_platform_facts_${crypto.randomUUID().slice(0, 8)}`;
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

function pointer(match: string, target: unknown) {
  return { type: "events.iterate.com/itx/rewrite-rule-configured", payload: { match, target } };
}
