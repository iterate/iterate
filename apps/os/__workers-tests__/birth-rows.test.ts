// __workers-tests__/birth-rows.test.ts — a context born with the deployment's birth rows
// (src/project/context-birth-events.ts).
import { expect, test } from "vitest";
import {
  at,
  bornWithBirthRows,
  freshProject,
  owedAlarmOf,
  pointAt,
  readLog,
  rowOf,
  rule,
  stub,
  until,
} from "./support.ts";

test("while the project's config is unpublished, a context's config row passes its events over: nothing owed, no alarm armed", async () => {
  const project = freshProject("prj_birth_rows");
  for (const ctx of [project, at(project, "/x")]) {
    await bornWithBirthRows(ctx);
    await stub(ctx).append({ type: "ping" });
    await settled(ctx);
  }
});

test("the commit that publishes the config is the first the config row delivers — the pointer on the root, the next event anywhere else; nothing committed before it is told", async () => {
  const project = freshProject("prj_birth_rows");
  const x = at(project, "/x");
  await bornWithBirthRows(project);
  await bornWithBirthRows(x);
  await stub(x).append({ type: "before" });
  await settled(x);
  await pointAt(project, RECORDING_CONFIG);
  await stub(x).append({ type: "after" });
  await until("x's `after` told", async () =>
    (await told(project)).some((event) => event.path === "/x" && event.type === "after"),
  );
  const events = await told(project);
  expect({
    first: events.find((event) => event.path === "/"),
    x: events.filter((event) => event.path === "/x"),
  }).toEqual({
    first: { path: "/", type: "events.iterate.com/itx/rewrite-rule-configured" },
    x: [{ path: "/x", type: "after" }],
  });
});

test("a context whose own rules mask all of `itx` still hands its events to the config entrypoint", async () => {
  const project = freshProject("prj_birth_rows");
  const jail = at(project, "/jail");
  await bornWithBirthRows(project);
  await pointAt(project, RECORDING_CONFIG);
  await bornWithBirthRows(jail);
  await stub(jail).append(rule("itx", null), { type: "ping" });
  await until("the jail's ping told", async () =>
    (await told(project)).some((event) => event.path === "/jail" && event.type === "ping"),
  );
});

/** Until `ctx`'s config row has settled every event it took: none pending, no alarm owed. */
const settled = (ctx: string) =>
  until(
    `${ctx}'s config row settled`,
    async () =>
      (await rowOf(ctx, "config"))?.pending === 0 && (await owedAlarmOf(stub(ctx))) === null,
  );

/** Every event the project's config entrypoint was told of, as RECORDING_CONFIG records it. */
async function told(project: string) {
  return (await readLog(at(project, "/sink")))
    .filter((event) => event.type === "told")
    .map((event) => event.payload as { path: string; type: string });
}

/** The project's config entrypoint: it records each event it is told of on `/sink`, once. */
const RECORDING_CONFIG = {
  "package.json": '{"main":"worker.js"}',
  "worker.js": /* js */ `
import { IterateConfigEntrypoint } from "iterate/sdk";
export default class extends IterateConfigEntrypoint {
  async processEvent({ event, itx }) {
    if (event.path === "/sink") return;
    await itx.cd("/sink").append({
      type: "told",
      payload: { path: event.path, type: event.type },
      idempotencyKey: "told:" + event.path + "@" + event.offset,
    });
  }
}
`,
};
