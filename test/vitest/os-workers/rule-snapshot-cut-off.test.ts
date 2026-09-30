// vitest/os-workers/rule-snapshot-cut-off.test.ts — a rule snapshot read whose request is gone
// before it answers, in workerd, where its promise never settles for anyone: the cache stops
// waiting on it once its lifetime ends and reads the table again. The cache's own contract is
// src/context/rule-snapshots.test.ts.
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { withTimeout } from "iterate/lib";
import { DurableObjectNameCodec } from "../../../core/os/src/context/paths.ts";
import {
  RuleSnapshotCache,
  SNAPSHOT_TTL_MS,
  type RulesSnapshotAnswer,
} from "../../../core/os/src/context/rule-snapshots.ts";
import { rule, stub } from "./support.ts";

test("a rule snapshot read whose context is aborted before it answers holds up no later read of that table", async () => {
  const root = `prj_cutoff_${crypto.randomUUID().slice(0, 8)}`;
  const owner = `${root}.iterate/agents/owner`;
  await stub(owner).append(rule("itx.tool", "itx.readEvents"));
  const table = DurableObjectNameCodec.parse(owner).name;
  const reads: (string | undefined)[] = [];
  const read = (ifVersion: string | undefined) => {
    reads.push(ifVersion);
    // The stub types the answer `never` (RulesSnapshotAnswer says why): read it as the cache does.
    return stub(owner).rulesSnapshot(ifVersion) as unknown as Promise<RulesSnapshotAnswer>;
  };
  // The cache's own clock, so the next read joins 100 ms before the first one's lifetime ends.
  const clock = { now: 0 };
  const cache = new RuleSnapshotCache({ now: () => clock.now });

  await runInDurableObject(stub(`${root}.iterate/agents/sender`), (_instance, state) => {
    void cache.get(table, read);
    state.abort("aborted while its snapshot read is out");
    return Promise.resolve();
  }).catch(() => undefined); // abort() throws by design

  clock.now = SNAPSHOT_TTL_MS - 100;
  expect(
    await withTimeout(cache.get(table, read), 2_000, "the next read of the table"),
  ).toMatchObject({ rules: [{ match: ["itx", "tool"], target: ["itx", "readEvents"] }] });
  expect(reads).toEqual([undefined, undefined]);
});
