import { expect, test } from "vitest";
import { EGRESS_RULES_MAX_QUIET_MS, egressRulesReadPlan } from "./egress-rules-read-plan.ts";

const rows: Array<{
  name: string;
  hasCachedRules: boolean;
  invalidatedByRootCommit: boolean;
  ageMs: number;
  becomes: ReturnType<typeof egressRulesReadPlan>;
}> = [
  {
    name: "fresh incarnation reads first",
    hasCachedRules: false,
    invalidatedByRootCommit: false,
    ageMs: 0,
    becomes: "await-refresh",
  },
  {
    name: "held copy answers a dial seconds later",
    hasCachedRules: true,
    invalidatedByRootCommit: false,
    ageMs: 5_001,
    becomes: "serve",
  },
  {
    name: "held copy answers a dial minutes later, refreshing behind",
    hasCachedRules: true,
    invalidatedByRootCommit: false,
    ageMs: EGRESS_RULES_MAX_QUIET_MS + 1,
    becomes: "serve-and-refresh",
  },
  {
    name: "exactly at the quiet bound still serves",
    hasCachedRules: true,
    invalidatedByRootCommit: false,
    ageMs: EGRESS_RULES_MAX_QUIET_MS,
    becomes: "serve",
  },
  {
    name: "a root-stream commit forces a read even when fresh",
    hasCachedRules: true,
    invalidatedByRootCommit: true,
    ageMs: 10,
    becomes: "await-refresh",
  },
  {
    name: "invalidated and old still awaits",
    hasCachedRules: true,
    invalidatedByRootCommit: true,
    ageMs: EGRESS_RULES_MAX_QUIET_MS * 2,
    becomes: "await-refresh",
  },
];

for (const row of rows) {
  test(row.name, () => {
    expect(
      egressRulesReadPlan({
        hasCachedRules: row.hasCachedRules,
        invalidatedByRootCommit: row.invalidatedByRootCommit,
        readAtMs: 1_000_000,
        nowMs: 1_000_000 + row.ageMs,
      }),
    ).toBe(row.becomes);
  });
}
