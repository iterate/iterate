// A durable delivery that began for an ordered row may finish only after that name has become a
// fan-out row. Its old direct target call is then stale: it cannot acknowledge the replacement or disturb
// the replacement's eight-call fan-out admission.

import { expect, test } from "vitest";
import { FANOUT_HOLD, HOLD } from "./sources.ts";
import { readLog, releasePins, stub, until } from "./support.ts";

test("an ordered target call settling after replacement cannot acknowledge or overwrite its fan-out successor", async () => {
  const context = "prj_delivery_ordered_to_fanout_replacement";
  const s = stub(context);
  const orderedTarget = ["itx", "facets", ["get", "ordered-hold", HOLD], "processEventBatch"];
  const fanoutTarget = ["itx", "facets", ["get", "fanout-hold", FANOUT_HOLD], "deliverEvent"];
  await s.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "swap",
      target: orderedTarget,
      delivery: "durable",
      consumes: ["test/held"],
    },
  });
  await s.append({ type: "test/held" });
  await until("the old ordered target call is held at its target", async () =>
    Boolean(await s.invoke(["itx", "facets", ["get", "ordered-hold", HOLD], ["holding"]])),
  );

  const [replacement] = (await s.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "swap",
      target: fanoutTarget,
      delivery: "durable",
      ordered: false,
      consumes: ["test/fanout"],
    },
  })) as { offset: number }[];
  const events = (await s.append(
    ...Array.from({ length: 16 }, (_, i) => ({ type: "test/fanout", payload: { i } })),
  )) as { offset: number }[];

  const fanout = (step: unknown[]) =>
    s.invoke(["itx", "facets", ["get", "fanout-hold", FANOUT_HOLD], step]);
  // The replacement owns a distinct runner and can admit its own fan-out work while the old raw
  // call remains held. Its progress must not be mistaken for an acknowledgement by that old call.
  const admitted = await until("the replacement admits its own fan-out work", async () => {
    const row = (
      (await s.invoke("itx.subscriptions.list()")) as Array<{
        name: string;
        configuredAtOffset: number;
        ordered?: boolean;
        pending?: number;
      }>
    ).find((row) => row.name === "swap");
    return row?.configuredAtOffset === replacement.offset && row.pending === 16 ? row : false;
  });
  expect(admitted).toMatchObject({
    configuredAtOffset: replacement.offset,
    ordered: false,
    pending: 16,
  });

  // This completes the OLD raw target call. Its stale settlement must not acknowledge the
  // successor or overwrite the successor's fan-out admission records.
  await s.invoke(["itx", "facets", ["get", "ordered-hold", HOLD], ["release"]]);
  await until(
    "the old target has returned",
    async () => !(await s.invoke(["itx", "facets", ["get", "ordered-hold", HOLD], ["holding"]])),
  );
  await until(
    "the successor starts exactly its bounded eight fan-out calls",
    async () => (await fanout(["holding"])) === 8,
  );
  expect(
    (
      (await s.invoke("itx.subscriptions.list()")) as Array<{
        name: string;
        configuredAtOffset: number;
        ordered?: boolean;
        pending?: number;
      }>
    ).find((row) => row.name === "swap"),
  ).toMatchObject({
    configuredAtOffset: replacement.offset,
    ordered: false,
    pending: 16,
  });

  // Releases are not credits: the target has no queued release when all eight first-wave calls
  // are still settling. Wait for the second bounded admission before releasing that wave too.
  for (let i = 0; i < 8; i++) await fanout(["release"]);
  await until(
    "the successor admits its second bounded fan-out wave",
    async () => (await fanout(["holding"])) === 8,
  );
  for (let i = 0; i < 8; i++) await fanout(["release"]);
  await until("the replacement alone confirms every fan-out event", async () => {
    const row = (
      (await s.invoke("itx.subscriptions.list()")) as Array<{
        name: string;
        configuredAtOffset: number;
        cursor?: { confirmedOffset: number };
        pending?: number;
      }>
    ).find((candidate) => candidate.name === "swap");
    return (
      row?.configuredAtOffset === replacement.offset &&
      row.cursor?.confirmedOffset !== undefined &&
      row.cursor.confirmedOffset >= events.at(-1)!.offset &&
      row.pending === 0
    );
  });
  expect(
    (await readLog(context)).filter(
      (event) =>
        event.type === "events.iterate.com/itx/subscription-delivery-failed" &&
        (event.payload as { name?: string }).name === "swap",
    ),
  ).toEqual([]);
  await releasePins(context);
});
