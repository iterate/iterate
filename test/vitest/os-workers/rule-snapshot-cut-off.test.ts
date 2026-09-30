// vitest/os-workers/rule-snapshot-cut-off.test.ts — a rule snapshot read whose request is gone
// before it answers. In workerd its promise never settles, for that request or any other, and
// `RuleSnapshotCache` shares one in-flight read per table with every caller in the isolate: each
// later read of that table joins the dead one and waits for as long as the isolate lives. The
// cache's own contract is core/os/src/context/rule-snapshots.test.ts.
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { createFailing } from "@iterate-com/shared/test-support/failing-test";
import { withTimeout } from "iterate/lib";
import { DurableObjectNameCodec } from "../../../core/os/src/context/paths.ts";
import {
  RuleSnapshotCache,
  SNAPSHOT_TTL_MS,
  type RulesSnapshotAnswer,
} from "../../../core/os/src/context/rule-snapshots.ts";
import { rule, stub } from "./support.ts";

createFailing(test, /the next read of the table \(1 read sent\): no answer in 2s/)(
  "a rule snapshot read whose context is aborted before it answers holds up no later read of that table",
  async () => {
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
    const clock = { now: 0 };
    const cache = new RuleSnapshotCache({ now: () => clock.now });

    await runInDurableObject(stub(`${root}.iterate/agents/sender`), (_instance, state) => {
      void cache.get(table, read);
      state.abort("aborted while its snapshot read is out");
      return Promise.resolve();
    }).catch(() => undefined); // abort() throws by design

    // 100 ms before the first read's snapshot would expire: its answer could still be used, if it came.
    clock.now = SNAPSHOT_TTL_MS - 100;
    const next = withTimeout(
      cache.get(table, read),
      2_000,
      () => `the next read of the table (${reads.length} read sent)`,
    );
    expect(await next).toMatchObject({
      rules: [{ match: ["itx", "tool"], target: ["itx", "readEvents"] }],
    });
  },
);
