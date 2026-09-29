// __workers-tests__/platform-facts.test.ts — only the platform writes its facts, at every door; the
// list of them is src/caller.test.ts's.
import { expect, test } from "vitest";
import { freshProject, PERSON, readLog, refused, rule, stub } from "./support.ts";

test.for([
  { name: "a platform fact", event: { type: "events.iterate.com/email/received", payload: {} } },
  { name: "the config pointer", event: rule("itx.config", ["itx", ["cd", "/c"], "w"]) },
])(
  "$name from anyone but the platform is FORBIDDEN: a member's, loaded code's, a raw append's and a schedule's; the log does not move",
  async ({ event }) => {
    const ctx = freshProject("prj_platform_writes");
    const head = (await readLog(ctx)).length;
    await refused(
      () => stub(ctx).invoke(["itx", ["append", event]], [], { principal: PERSON }),
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
          { principal: PERSON },
        ),
      "FORBIDDEN",
    );
    expect(await readLog(ctx)).toHaveLength(head);
  },
);
