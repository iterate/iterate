// __workers-tests__/birth-rows.test.ts — A CONTEXT BORN WITH THE DEPLOYMENT'S BIRTH ROWS (envs.ts
// `PROJECT_CONTEXT_BIRTH_EVENTS`): its `config` fan-out row hands every durable event of its own, its
// birth included, to the project's config entrypoint, `itx.config` on `/`, in the context itself.
// One born before the project's first publication has nothing to deliver to: its row dangles, and
// probes again as the root's snapshot that refused it expires (src/stream/subscription-delivery.ts),
// so the pointer's landing reaches it within SNAPSHOT_TTL_MS with no commit of its own.
import { expect, test } from "vitest";
import { SNAPSHOT_TTL_MS } from "../src/context/rule-snapshots.ts";
import { appendAsPlatform, bornWithBirthRows, readLog, stub, until } from "./support.ts";

test("a context born before the project's first publication hands the config entrypoint what waited — its birth included — within SNAPSHOT_TTL_MS of the pointer's landing, with no commit of its own", async () => {
  const project = `prj_birth_rows_${crypto.randomUUID().slice(0, 8)}`;
  const x = `${project}.iterate/x`;
  await bornWithBirthRows(project);
  await bornWithBirthRows(x);
  await stub(x).append({ type: "ping" });
  // its row has tried and found no `itx.config` on `/`
  await until("x's row dangles", async () => {
    const row = (await stub(x).invoke("itx.subscriptions.get('config')")) as {
      pending?: number;
    } | null;
    return (row?.pending ?? 0) > 0;
  });

  const landed = Date.now();
  await appendAsPlatform(project, {
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: {
      match: "itx.config",
      target: ["itx", "builtins", "workers", ["get", { source: RECORDING_CONFIG }]],
    },
  });
  // what waited is told in any order (a fan-out row's calls race): its birth, its row, its ping
  const waited = [
    "events.iterate.com/itx/created",
    "events.iterate.com/itx/subscription-configured",
    "ping",
  ];
  await until(
    "x's waiting events told",
    async () => {
      const told = (await readLog(`${project}.iterate/sink`))
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
