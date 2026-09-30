// __workers-tests__/rule-snapshot-cut-off.test.ts — a rule snapshot read whose request is gone
// before it answers, in workerd: its promise never settles, for the caller that sent it or any
// other. The cache's own contract is src/context/rule-snapshots.test.ts.
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { createFailing } from "@iterate-com/shared/test-support/failing-test";
import { withTimeout } from "iterate/lib";
import { DurableObjectNameCodec } from "../src/context/paths.ts";
import {
  RuleSnapshotCache,
  SNAPSHOT_TTL_MS,
  type RulesSnapshotAnswer,
} from "../src/context/rule-snapshots.ts";
import { rule, stub } from "./support.ts";

// prd 2026-09-30: a deploy cut off the request that had sent the read of iterate.com's
// /repos/config table, and every later call through that table in the isolate joined the dead read
// until the next deploy, 28 minutes later.
createFailing(test, /the next read of the table: no answer in 2s/)(
  "a rule snapshot read whose context is aborted before it answers holds up no later read of that table",
  async () => {
    const root = `prj_cutoff_${crypto.randomUUID().slice(0, 8)}`;
    const owner = `${root}.iterate/repos/config`;
    await stub(owner).append(rule("itx.tool", "itx.readEvents"));
    const table = DurableObjectNameCodec.parse(owner).name;
    const reads: (string | undefined)[] = [];
    const read = (ifVersion: string | undefined) => {
      reads.push(ifVersion);
      return stub(owner).rulesSnapshot(ifVersion) as unknown as Promise<RulesSnapshotAnswer>;
    };
    // The cache's own clock, so the next read joins 100 ms before the first one's lifetime ends.
    const clock = { now: 0 };
    const cache = new RuleSnapshotCache({ now: () => clock.now });

    await runInDurableObject(stub(`${root}.iterate/agents/a`), (_instance, state) => {
      void cache.get(table, read);
      state.abort("aborted while its snapshot read is out");
      return Promise.resolve();
    }).catch(() => undefined); // abort() throws by design

    clock.now = SNAPSHOT_TTL_MS - 100;
    expect(
      await withTimeout(cache.get(table, read), 2_000, "the next read of the table"),
    ).toMatchObject({ rules: [{ match: ["itx", "tool"], target: ["itx", "readEvents"] }] });
    expect(reads).toEqual([undefined, undefined]);
  },
);
