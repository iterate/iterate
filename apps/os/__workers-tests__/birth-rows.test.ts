// __workers-tests__/birth-rows.test.ts — a context born with the deployment's birth rows (envs.ts).
import { expect, test } from "vitest";
import { SNAPSHOT_TTL_MS } from "../src/context/rule-snapshots.ts";
import {
  at,
  bornWithBirthRows,
  freshProject,
  pointAt,
  readLog,
  rowOf,
  stub,
  until,
} from "./support.ts";

test("a context born before the first publication hands the config entrypoint what waited, its birth included, within the TTL", async () => {
  const project = freshProject("prj_birth_rows");
  const x = at(project, "/x");
  await bornWithBirthRows(project);
  await bornWithBirthRows(x);
  await stub(x).append({ type: "ping" });
  await until("x's row dangles", async () => ((await rowOf(x, "config"))?.pending ?? 0) > 0);
  const landed = Date.now();
  await pointAt(project, RECORDING_CONFIG);
  // what waited is told in any order (a fan-out row's calls race): its birth, its row, its ping
  const waited = [
    "events.iterate.com/itx/created",
    "events.iterate.com/itx/subscription-configured",
    "ping",
  ];
  await until(
    "x's waiting events told",
    async () => {
      const told = (await readLog(at(project, "/sink")))
        .filter((event) => event.type === "told")
        .map((event) => event.payload as { path: string; type: string });
      return waited.every((type) =>
        told.some((event) => event.path === "/x" && event.type === type),
      );
    },
    SNAPSHOT_TTL_MS * 3,
  );
  expect(Date.now() - landed).toBeLessThan(SNAPSHOT_TTL_MS + 1_500);
});

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
