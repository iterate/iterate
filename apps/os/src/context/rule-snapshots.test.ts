// context/rule-snapshots.test.ts — another context's rule table as an isolate holds it: the cache's
// lifetime, its version-conditional and single-flight reads, and which writes wait out the older
// snapshots. The Workers rows
// (__workers-tests__/rule-snapshots.test.ts) prove the same across real contexts.
import { expect, test, vi } from "vitest";
import { parse, parseItxExpressionPrefix, print } from "iterate/expression";
import {
  BUILT_IN_ROOTS,
  CONTEXT_ROOTS,
  namesTakenAway,
  rulesChangeNeedsCommitWait,
  type ItxExpressionRewriteRule,
} from "./itx-expression-rewriting.ts";
import {
  MAX_HELD_SNAPSHOTS,
  RuleSnapshotCache,
  SNAPSHOT_TTL_MS,
  type RulesSnapshotAnswer,
} from "./rule-snapshots.ts";

test("a snapshot is read once and used until SNAPSHOT_TTL_MS after its read was sent; then re-read conditionally, an unchanged table answering its version alone", async () => {
  const { cache, clock, owner } = setup();
  owner.rules = [row("itx.tool ⇒ itx.kv")];
  expect(await cache.get("/", owner.read)).toMatchObject({
    rules: owner.rules,
    expiresAt: SNAPSHOT_TTL_MS,
  });
  clock.now = SNAPSHOT_TTL_MS - 1;
  await cache.get("/", owner.read);
  expect(owner).toMatchObject({ reads: [undefined] });
  clock.now = SNAPSHOT_TTL_MS;
  expect(await cache.get("/", owner.read)).toMatchObject({
    rules: [row("itx.tool ⇒ itx.kv")],
    expiresAt: 2 * SNAPSHOT_TTL_MS,
  });
  // the second read named the version it held, and the owner answered that version alone
  expect(owner).toMatchObject({ reads: [undefined, "v1"] });
});

test("a changed table answers its new rows on the conditional read", async () => {
  const { cache, clock, owner } = setup();
  owner.rules = [row("itx.tool ⇒ itx.kv")];
  await cache.get("/", owner.read);
  owner.version = "v2";
  owner.rules = [row("itx.tool ⇒ itx.r2")];
  clock.now = SNAPSHOT_TTL_MS;
  expect(await cache.get("/", owner.read)).toMatchObject({ rules: [row("itx.tool ⇒ itx.r2")] });
});

test("reads are single-flight per owner: concurrent resolutions share one read", async () => {
  const { cache, owner } = setup();
  const answers = await Promise.all([
    cache.get("/", owner.read),
    cache.get("/", owner.read),
    cache.get("/other", owner.read),
  ]);
  expect(answers).toHaveLength(3);
  expect(owner).toMatchObject({ reads: [undefined, undefined] });
});

test("a read that answers after its snapshot's lifetime is never used, by the call that sent it or one that joined it: both read again", async () => {
  const { cache, clock, owner } = setup();
  owner.delayed = true;
  const sender = cache.get("/", owner.read);
  clock.now = SNAPSHOT_TTL_MS + 1;
  const joiner = cache.get("/", owner.read);
  owner.answer(); // the first read, sent at 0, answers at 5001
  await vi.waitFor(() => expect(owner.reads).toHaveLength(2));
  owner.answer(); // the second, sent at 5001
  expect(await Promise.all([sender, joiner])).toMatchObject([
    { expiresAt: 2 * SNAPSHOT_TTL_MS + 1 },
    { expiresAt: 2 * SNAPSHOT_TTL_MS + 1 },
  ]);
  expect(owner).toMatchObject({ reads: [undefined, "v1"] });
});

test("an owner whose snapshots keep arriving expired is UNAVAILABLE after three reads, never answered from them", async () => {
  const { cache, clock, owner } = setup();
  owner.onRead = () => (clock.now += SNAPSHOT_TTL_MS);
  await expect(cache.get("/", owner.read)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(owner.reads).toHaveLength(3);
});

test("the cache keeps at most its cap of contexts, the oldest read out first: an evicted context is read again, unconditionally", async () => {
  const { cache, owner } = setup();
  for (let n = 0; n <= MAX_HELD_SNAPSHOTS; n++) await cache.get(`/${n}`, owner.read);
  await cache.get("/1", owner.read); // still held
  await cache.get("/0", owner.read); // evicted by the last
  expect(owner).toMatchObject({ reads: Array(MAX_HELD_SNAPSHOTS + 2).fill(undefined) });
});

test("a read that fails is not kept: the next resolution reads again", async () => {
  const { cache, owner } = setup();
  owner.fail = true;
  await expect(cache.get("/", owner.read)).rejects.toThrow("owner down");
  owner.fail = false;
  expect(await cache.get("/", owner.read)).toMatchObject({ rules: [] });
  expect(owner).toMatchObject({ reads: [undefined, undefined] });
});

test("a read a deploy's reset fails is made once more at once, logged, and lasts from when the first was sent", async () => {
  const { cache, clock, owner } = setup();
  const lines = vi.spyOn(console, "info").mockImplementation(() => {});
  owner.resets = 1;
  owner.onRead = () => (clock.now += 100);
  expect(await cache.get("/", owner.read)).toMatchObject({ expiresAt: SNAPSHOT_TTL_MS });
  expect(owner.reads).toHaveLength(2);
  expect(lines.mock.calls.map(([line]) => line.event)).toEqual([
    "rule-snapshot.deploy-reset-retry",
  ]);
});

test("a read a deploy's reset fails twice is UNAVAILABLE, its kind deploy-reset", async () => {
  const { cache, owner } = setup();
  vi.spyOn(console, "info").mockImplementation(() => {});
  owner.resets = 2;
  await expect(cache.get("/", owner.read)).rejects.toMatchObject({
    code: "UNAVAILABLE",
    data: { kind: "deploy-reset" },
  });
  expect(owner.reads).toHaveLength(2);
});

test.for([
  {
    name: "a new name answers at once",
    before: [],
    after: ["itx.tool ⇒ itx.kv"],
    at: "child",
    waits: false,
  },
  {
    name: "a description alone answers at once",
    before: ["itx.tool ⇒ itx.kv"],
    after: ["itx.tool ⇒ itx.kv — the store"],
    at: "child",
    waits: false,
  },
  {
    name: "a grant re-pointed waits",
    before: ["itx.tool ⇒ itx.kv"],
    after: ["itx.tool ⇒ itx.r2"],
    at: "child",
    waits: true,
  },
  {
    name: "a grant removed waits",
    before: ["itx.tool ⇒ itx.kv"],
    after: [],
    at: "child",
    waits: true,
  },
  {
    name: "a grant masked waits",
    before: ["itx.tool ⇒ itx.kv"],
    after: ["itx.tool ⇒ null"],
    at: "child",
    waits: true,
  },
  {
    name: "a mask on a name that answered waits",
    before: [],
    after: ["itx.append ⇒ null"],
    at: "child",
    waits: true,
  },
  {
    name: "a mask lifted waits",
    before: ["itx.append ⇒ null"],
    after: [],
    at: "child",
    waits: true,
  },
  {
    name: "a mask replaced by a grant waits",
    before: ["itx.append ⇒ null"],
    after: ["itx.append ⇒ itx.kv"],
    at: "child",
    waits: true,
  },
  {
    name: "a grant shadowing an implicit root waits",
    before: [],
    after: ["itx.ai ⇒ itx.tool"],
    at: "root",
    waits: true,
  },
  {
    name: "a pinned grant under an implicit root waits",
    before: [],
    after: ["itx.ai.run('gpt-5') ⇒ itx.tool"],
    at: "root",
    waits: true,
  },
  {
    name: "a project root's name at a child answers at once",
    before: [],
    after: ["itx.ai ⇒ itx.tool"],
    at: "child",
    waits: false,
  },
  {
    name: "a name behind the parent link waits",
    before: ["itx ⇒ itx.cd('/')"],
    after: ["itx.ai ⇒ itx.tool", "itx ⇒ itx.cd('/')"],
    at: "child",
    waits: true,
  },
  {
    name: "a longer row under a grant waits",
    before: ["itx.tool ⇒ itx.append"],
    after: ["itx.tool ⇒ itx.append", "itx.tool.x ⇒ itx.readEvents"],
    at: "child",
    waits: true,
  },
  {
    name: "a new parent link answers at once",
    before: [],
    after: ["itx ⇒ itx.cd('/')"],
    at: "child",
    waits: false,
  },
  { name: "a jail's bare null waits", before: [], after: ["itx ⇒ null"], at: "child", waits: true },
  {
    name: "a name re-added while a pending fence holds it taken away waits",
    before: [],
    after: ["itx.tool.x ⇒ itx.r2"],
    takenAway: ["itx.tool"],
    at: "child",
    waits: true,
  },
])("$name", ({ before, after, takenAway = [], at, waits }) => {
  const taken = takenAway.map((match) => parseItxExpressionPrefix(match));
  expect(rulesChangeNeedsCommitWait(table(before), table(after), IMPLICIT[at]!, taken)).toBe(waits);
});

test("what a change takes away is every row removed or re-pointed but a mask and a row whose target lives in its context", () => {
  const before = table([
    "itx.kept ⇒ itx.kv",
    "itx.removed ⇒ itx.kv",
    "itx.repointed ⇒ itx.builtins.kv.get('a')",
    "itx.masked ⇒ null",
    "itx.lent ⇒ itx.builtins.rpcStubs.get('itx.lent')",
    "itx.reached ⇒ itx.builtins.cd('/b').tool",
  ]);
  const after = table(["itx.kept ⇒ itx.kv", "itx.repointed ⇒ itx.builtins.kv.get('b')"]);
  expect(namesTakenAway(before, after).map((match) => print(match))).toEqual([
    "itx.removed",
    "itx.repointed",
    "itx.reached",
  ]);
});

/** The roots implicit at a project's root and at a child (`implicitRootsAt`). */
const IMPLICIT: Record<string, ReadonlySet<string>> = {
  root: new Set(BUILT_IN_ROOTS),
  child: new Set(CONTEXT_ROOTS),
};

/** An owner answering `rulesSnapshot(ifVersion)`, recording what each read asked, and a clock.
 *  `delayed`: each read answers when `answer()` is called, in order; `onRead` runs as a read is
 *  answered (a clock that moves while the read is in flight); `resets`: how many reads a deploy's
 *  reset fails first. */
function setup() {
  const clock = { now: 0 };
  const pending: (() => void)[] = [];
  const owner = {
    version: "v1",
    rules: [] as ItxExpressionRewriteRule[],
    reads: [] as (string | undefined)[],
    fail: false,
    resets: 0,
    delayed: false,
    onRead: () => {},
    answer: () => pending.shift()?.(),
    read: async (ifVersion: string | undefined): Promise<RulesSnapshotAnswer> => {
      owner.reads.push(ifVersion);
      if (owner.delayed) await new Promise<void>((resolve) => pending.push(resolve));
      owner.onRead();
      if (owner.fail) throw new Error("owner down");
      if (owner.resets-- > 0) throw new Error("Durable Object reset because its code was updated.");
      return ifVersion === owner.version
        ? { version: owner.version }
        : {
            version: owner.version,
            rules: owner.rules,
            routing: { fetchRoutes: {}, ingressTarget: null },
          };
    },
  };
  return { cache: new RuleSnapshotCache({ now: () => clock.now }), clock, owner };
}

/** `"match ⇒ target"`, `null` a mask, ` — text` a description. */
function row(spelled: string): ItxExpressionRewriteRule {
  const [, match, target, description] = /^(.+?) ⇒ (.+?)(?: — (.+?))?$/.exec(spelled)!;
  return {
    match: parseItxExpressionPrefix(match!),
    target: target === "null" ? null : parse(target!),
    description,
  };
}

/** A table by canonical match, as core state keeps it. */
function table(rows: string[]): Record<string, ItxExpressionRewriteRule> {
  return Object.fromEntries(rows.map((spelled) => [spelled.split(" ⇒ ")[0], row(spelled)]));
}
