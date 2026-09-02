// context/routing.test.ts — THE TABLE: given these mounts and this call, this is the call that runs.
// Every rule in routing.ts is a row here; read the rows, not the code. Mounts are written
// `"path ⇒ target"`, later rows are NEWER (providedAtOffset = position). Built-in roots for the
// table: kv, whoami, rpcStubs, load.
import { describe, expect, test } from "vitest";
import type { Mount } from "../stream/core-processor.ts";
import { parse, parseItxExpressionPrefix, print } from "./expression.ts";
import { matchMount, routeCall } from "./routing.ts";

const BUILT_IN_ROOTS = new Set(["kv", "whoami", "rpcStubs", "load"]);
const table = (rows: string[]): Mount[] =>
  rows.map((row, i) => {
    const [path, target] = row.split(" ⇒ ");
    return { path: parseItxExpressionPrefix(path), target: parse(target), providedAtOffset: i + 1 };
  });
/** The call that runs, printed — or the refusal. */
const runs = (mounts: string[], call: string): string => {
  try {
    return print(routeCall(table(mounts), parse(call), (root) => BUILT_IN_ROOTS.has(root)));
  } catch (error) {
    return `THROWS ${(error as Error).message}`;
  }
};

describe("routeCall — the call that runs", () => {
  const rows: { mounts: string[]; call: string; becomes: string }[] = [
    // a built-in root needs no mount
    { mounts: [], call: "itx.kv.get('k')", becomes: "itx.kv.get('k')" },
    // one mount: the prefix is replaced by the target, the rest of the call follows
    { mounts: ["itx.db ⇒ itx.kv"], call: "itx.db.get('k')", becomes: "itx.kv.get('k')" },
    // mounts compose by naming each other; a LONGER mount under the target's path captures the deeper call
    {
      mounts: ["itx.store ⇒ itx.kv", "itx.store.deep ⇒ itx.whoami", "itx.db ⇒ itx.store"],
      call: "itx.db.deep()",
      becomes: "itx.whoami()",
    },
    {
      mounts: ["itx.store ⇒ itx.kv", "itx.store.deep ⇒ itx.whoami", "itx.db ⇒ itx.store"],
      call: "itx.db.get('k')",
      becomes: "itx.kv.get('k')",
    },
    // args at the mount fold into the target's final NAME step
    { mounts: ["itx.grok ⇒ itx.kv.get"], call: "itx.grok('k')", becomes: "itx.kv.get('k')" },
    // …and become an ANONYMOUS call when the target already ends in a call (a live value, root-called);
    // the canonical print form spells args without spaces
    {
      mounts: ["itx.cam ⇒ itx.rpcStubs.get('itx.cam')"],
      call: "itx.cam(1,2)",
      becomes: "itx.rpcStubs.get('itx.cam')(1,2)",
    },
    {
      mounts: ["itx.cam ⇒ itx.rpcStubs.get('itx.cam')"],
      call: "itx.cam.shot()",
      becomes: "itx.rpcStubs.get('itx.cam').shot()",
    },
    // the LONGEST path wins, even over a newer shorter one
    {
      mounts: ["itx.a.b ⇒ itx.whoami", "itx.a ⇒ itx.kv"],
      call: "itx.a.b.f()",
      becomes: "itx.whoami.f()",
    },
    {
      mounts: ["itx.a.b ⇒ itx.whoami", "itx.a ⇒ itx.kv"],
      call: "itx.a.c()",
      becomes: "itx.kv.c()",
    },
    // same path: the NEWEST wins (the shadow stack)
    {
      mounts: ["itx.g ⇒ itx.kv", "itx.g ⇒ itx.whoami"],
      call: "itx.g.hello()",
      becomes: "itx.whoami.hello()",
    },
    // PINNED ARGS: `itx.ai.run('special')` beats `itx.ai.run` whatever their ages; the pinned arg is consumed
    {
      mounts: ["itx.ai.run('special') ⇒ itx.whoami", "itx.ai.run ⇒ itx.kv.get"],
      call: "itx.ai.run('special')",
      becomes: "itx.whoami()",
    },
    {
      mounts: ["itx.ai.run('special') ⇒ itx.whoami", "itx.ai.run ⇒ itx.kv.get"],
      call: "itx.ai.run('other')",
      becomes: "itx.kv.get('other')",
    },
    // unpinned trailing args are the call on the target (partial application)
    {
      mounts: ["itx.ai.run('special') ⇒ itx.kv.get"],
      call: "itx.ai.run('special', 'k')",
      becomes: "itx.kv.get('k')",
    },
    // two pinned args outrank one
    {
      mounts: ["itx.ai.run('m') ⇒ itx.kv.get", "itx.ai.run('m', 'fast') ⇒ itx.whoami"],
      call: "itx.ai.run('m', 'fast')",
      becomes: "itx.whoami()",
    },
    {
      mounts: ["itx.ai.run('m') ⇒ itx.kv.get", "itx.ai.run('m', 'fast') ⇒ itx.whoami"],
      call: "itx.ai.run('m', 'slow')",
      becomes: "itx.kv.get('slow')",
    },
    // a MID-PATH pinned step is consumed too (the target replaces it)
    {
      mounts: ["itx.repo.get('main').files ⇒ itx.kv.get"],
      call: "itx.repo.get('main').files('k')",
      becomes: "itx.kv.get('k')",
    },
    // structural equality: key order in a pinned object is irrelevant
    {
      mounts: ["itx.ai.run({ a: 1, b: 2 }) ⇒ itx.whoami"],
      call: "itx.ai.run({ b: 2, a: 1 })",
      becomes: "itx.whoami()",
    },
  ];
  for (const { mounts, call, becomes } of rows)
    test(`${call}  with  [${mounts.join(" | ") || "no mounts"}]  runs  ${becomes}`, () => {
      expect(runs(mounts, call)).toBe(becomes);
    });

  const refusals: { mounts: string[]; call: string; throws: RegExp }[] = [
    { mounts: [], call: "itx.nope()", throws: /no capability matches "itx\.nope\(\)"/ },
    // a literal that differs and no plain mount beneath → nothing matches
    {
      mounts: ["itx.ai.run('special') ⇒ itx.whoami"],
      call: "itx.ai.run('other')",
      throws: /no capability matches/,
    },
    // a residual arg on a NON-final pinned step has nowhere to go
    {
      mounts: ["itx.repo.get('main').files ⇒ itx.kv.get"],
      call: "itx.repo.get('main', 'x').files('k')",
      throws: /no capability matches/,
    },
    // a property is not a call: the pinned mount does not claim `itx.ai.run`
    {
      mounts: ["itx.ai.run('special') ⇒ itx.whoami"],
      call: "itx.ai.run",
      throws: /no capability matches/,
    },
    // a target not rooted at itx (a smuggled event) is denied whole — the built-ins are unreachable by name
    {
      mounts: ["itx.evil ⇒ kv"],
      call: "itx.evil.get('a')",
      throws: /no capability matches "kv\.get/,
    },
    // a self-referential mount errors at the depth budget, never spins
    { mounts: ["itx.loop ⇒ itx.loop"], call: "itx.loop.go()", throws: /depth 32/ },
  ];
  for (const { mounts, call, throws } of refusals)
    test(`${call}  with  [${mounts.join(" | ") || "no mounts"}]  is refused: ${throws}`, () => {
      expect(runs(mounts, call)).toMatch(throws);
    });

  test("the depth budget: a chain of 32 mounts naming mounts resolves, 33 trips", () => {
    const chain = (n: number) =>
      Array.from(
        { length: n },
        (_, i) => `itx.c${i} ⇒ ${i === 0 ? "itx.whoami" : `itx.c${i - 1}`}`,
      );
    expect(runs(chain(32), "itx.c31()")).toBe("itx.whoami()");
    expect(runs(chain(33), "itx.c32()")).toMatch(/depth 32/);
  });
});

describe("matchMount — one mount against one call", () => {
  const rows: { path: string; call: string; match: ReturnType<typeof matchMount> }[] = [
    {
      path: "itx.a.b",
      call: "itx.a.b.c()",
      match: { unpinnedArgs: undefined, stepsAfterMount: [["c"]] },
    },
    { path: "itx.a.b", call: "itx.a.b(1)", match: { unpinnedArgs: [1], stepsAfterMount: [] } }, // a name's FINAL step may claim a call
    { path: "itx.a.b", call: "itx.a(1).b", match: null }, // a call at a NON-final name step is not that name
    { path: "itx.a.b", call: "itx.a", match: null }, // the path is longer than the call
    {
      path: "itx.ai.run('gpt-5')",
      call: "itx.ai.run('gpt-5', { n: 1 })",
      match: { unpinnedArgs: [{ n: 1 }], stepsAfterMount: [] },
    },
    { path: "itx.ai.run('gpt-5')", call: "itx.ai.run('other')", match: null },
    { path: "itx.ai.run('gpt-5')", call: "itx.ai.run", match: null },
    {
      path: "itx.repo.get('main').files",
      call: "itx.repo.get('main').files('k')",
      match: { unpinnedArgs: ["k"], stepsAfterMount: [] },
    },
    {
      path: "itx.repo.get('main').files",
      call: "itx.repo.get('main', 'x').files('k')",
      match: null,
    },
  ];
  for (const { path, call, match } of rows)
    test(`${path}  against  ${call}  →  ${match ? `${print(match.stepsAfterMount) || "(nothing after)"}${match.unpinnedArgs ? `, unpinned ${JSON.stringify(match.unpinnedArgs)}` : ""}` : "no match"}`, () => {
      expect(matchMount(parseItxExpressionPrefix(path), parse(call))).toEqual(match);
    });
});

describe("the anonymous call step round-trips the codec", () => {
  test("`f(x)(y)` parses to an anonymous call and prints back; a capability path may not use it", () => {
    expect(parse("itx.rpcStubs.get('cam')(1,2)")).toEqual([
      "itx",
      "rpcStubs",
      ["get", "cam"],
      ["", 1, 2],
    ]);
    expect(print(["itx", "rpcStubs", ["get", "cam"], ["", 1, 2]])).toBe(
      "itx.rpcStubs.get('cam')(1,2)",
    );
    expect(() => parseItxExpressionPrefix("itx.a.b('x')(1)")).toThrow(/cannot call a result/);
  });
});
