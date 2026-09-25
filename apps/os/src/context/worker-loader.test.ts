// context/worker-loader.test.ts — the Worker Loader cacheKey is an AUTHORITY boundary: the
// isolate's whole world (its env.ITX host stub, its globalOutbound) is baked in at first
// materialization, so two callers who compose the same key SHARE an isolate. prepareConfinedWorker
// mints the JSON array `[kind, deploy, platformOrigin, owner, sourceVersion]` (the caller's cacheKey,
// else the modules' content hash) WITHOUT asking the loader — `load()` is the one call that does (the
// last-but-one row). A facet's owner is the pair (context name, class name), and either half may
// contain ":" (a context path is any string; ES2022 allows `export { X as "y:Tally" }`); as one JSON
// element of the id, the pair is unambiguous whatever either half contains. The second
// half pins Cloudflare's `get(id, getCode)` contract as we use it: a PRODUCER expression runs inside
// `getCode` (a cold isolate only) and is refused without a cacheKey. The last row pins the workerd
// WORKAROUND (worker-loader.ts `loaderIdGenerations`): a producer that threw marks its id dead, the
// next attempt produces outside the loader and loads literally under the id's next generation, and
// the callers that find it dead while that attempt runs wait on it (two rows, under load).
import { expect, test } from "vitest";
import { DurableObjectNameCodec } from "./paths.ts";
import {
  assertFacetSourceWithinCeiling,
  FACET_SOURCE_MAX_CHARS,
  prepareConfinedWorker,
} from "./worker-loader.ts";

test("two literal sources whose djb2 hashes collide never share one Worker Loader cacheKey", async () => {
  // djb2("Aa") === djb2("B@") — one 32-bit hash, two sources.
  const { env, keys } = fakeLoaderEnv();
  await loadConfined(env, { source: { "worker.js": "Aa" } });
  await loadConfined(env, { source: { "worker.js": "B@" } });
  expect(new Set(keys)).toMatchObject({ size: 2 });
});

test("an owner and a caller's cacheKey that concatenate alike never share one Worker Loader cacheKey", async () => {
  // owner "…/x" + key "y:z" vs owner "…/x:y" + key "z": joined with ":" they would spell ONE id.
  const { env, keys } = fakeLoaderEnv();
  const source = { "worker.js": "export default class W {}" };
  await loadConfined(env, { owner: "prj_u.iterate/x", cacheKey: "y:z", source });
  await loadConfined(env, { owner: "prj_u.iterate/x:y", cacheKey: "z", source });
  expect(new Set(keys)).toMatchObject({ size: 2 });
});

test("two DIFFERENT facet identities never share one Worker Loader cacheKey", async () => {
  // context "/x:y" + class "Tally" vs context "/x" + class "y:Tally": a naive `${context}:${class}`
  // owner composes the IDENTICAL "prj_u.iterate/x:y:Tally" — the second caller would reuse the
  // first's isolate, a silent cross-context authority transfer. Same shared source (identical
  // contentHash), as in prod.
  const { env, keys } = fakeLoaderEnv();
  const modules = { "worker.js": "export default class Tally {}" };
  const load = (iterateContextName: string, className: string) =>
    loadConfined(env, {
      kind: "facet",
      owner: [iterateContextName, className],
      source: modules,
      where: `facet "${className}"`,
    });
  await load(DurableObjectNameCodec.stringify({ projectId: "prj_u", path: "/x:y" }), "Tally");
  await load(DurableObjectNameCodec.stringify({ projectId: "prj_u", path: "/x" }), "y:Tally");
  // distinct — each half is its own JSON string in the id
  const [first, second] = keys;
  expect(keys).toHaveLength(2);
  expect(first).not.toBe(second);
});

test("a producer source runs INSIDE getCode — once per cold isolate, never on a warm key — and needs a cacheKey", async () => {
  const { env, keys } = fakeLoaderEnv();
  let produced = 0;
  const invoke = async () => {
    produced++;
    return { "worker.js": "export default class Built {}" };
  };
  const load = (cacheKey?: string) =>
    loadConfined(env, { source: "itx.build('todo')", cacheKey, invoke });
  // refused without a key: hashing the expression would be the stale-code trap
  await expect(load()).rejects.toThrow(/needs a cacheKey/);
  expect(produced).toBe(0);
  // with a key: the producer runs when the key is cold …
  const first = await load("todo@3f2a1c");
  expect(first).toMatchObject({
    loaderId: JSON.stringify(["worker", "deploy-1", null, "prj_u.iterate/", "todo@3f2a1c"]),
  });
  expect(keys.at(-1)).toBe(first.loaderId);
  await settled(); // let getCode's async body run
  expect(produced).toBe(1);
  // … and NOT when it is warm — "same key ⇒ same code" is the caller's contract
  await load("todo@3f2a1c");
  await settled();
  expect(produced).toBe(1);
  // a new key is a new isolate: the producer runs again
  await load("todo@4b7d");
  await settled();
  expect(produced).toBe(2);
});

test("literal modules: the key is their content hash unless the caller names a cacheKey", async () => {
  const { env, keys } = fakeLoaderEnv();
  const a = await loadConfined(env, { source: { "worker.js": "export default 1" } });
  const b = await loadConfined(env, { source: { "worker.js": "export default 2" } });
  expect(a).not.toMatchObject({ loaderId: b.loaderId }); // content decides
  const named = await loadConfined(env, {
    source: { "worker.js": "export default 1" },
    cacheKey: "v7",
  });
  expect(named).toMatchObject({
    loaderId: JSON.stringify(["worker", "deploy-1", null, "prj_u.iterate/", "v7"]),
  });
  expect(keys.at(-1)).toBe(named.loaderId);
  await expect(loadConfined(env, { source: { "lib.js": "export default 1" } })).rejects.toThrow(
    /no entry/,
  );
});

test("WORKAROUND: a producer that threw marks its id dead; the next attempt produces OUTSIDE the loader and loads literally under the id's next generation; a producer that keeps failing mints nothing", async () => {
  const { env, keys, warm } = fakeLoaderEnv();
  let artifactLanded = false;
  let produced = 0;
  const invoke = async () => {
    produced++;
    if (!artifactLanded) throw new Error("build artifact not landed yet");
    return { "worker.js": "export default class Built {}" };
  };
  const load = () =>
    loadConfined(env, { source: "itx.build('todo')", cacheKey: "todo@dead", invoke });
  // 1. the producer throws INSIDE getCode — workerd keeps that rejection under the id forever
  const first = await load();
  expect(first).toMatchObject({
    loaderId: JSON.stringify(["worker", "deploy-1", null, "prj_u.iterate/", "todo@dead"]),
  });
  await expect(warm.get(first.loaderId)).rejects.toThrow(/not landed/);
  expect(produced).toBe(1);
  // 2. still failing: the producer now runs OUTSIDE the loader — the failure reaches no map entry
  //    and mints no id, however many times it is tried
  await expect(load()).rejects.toThrow(/not landed/);
  await expect(load()).rejects.toThrow(/not landed/);
  expect(produced).toBe(3);
  expect(keys).toHaveLength(1);
  // 3. the artifact lands: produced outside once more, loaded LITERALLY under the next generation
  artifactLanded = true;
  const recovered = await load();
  expect(recovered).toMatchObject({
    loaderId: `${JSON.stringify(["worker", "deploy-1", null, "prj_u.iterate/", "todo@dead"])}#1`,
  });
  await expect(warm.get(recovered.loaderId)).resolves.toMatchObject({
    modules: { "worker.js": "export default class Built {}" },
  });
  expect(produced).toBe(4);
  // 4. …and from here the generation is warm: no producer run, no new id
  await load();
  expect(produced).toBe(4);
  expect(new Set(keys)).toMatchObject({ size: 2 }); // the dead id and its one recovered generation
});

test("a source that keeps failing to resolve mints one loader id, not one per retry: the recovery resolves outside the loader", async () => {
  const { env, keys } = fakeLoaderEnv();
  const retry = () => loadConfined(env, { source: { "worker.js": `import "./missing.js";` } });
  await retry(); // the cold load resolves inside getCode, fails, and marks the id dead
  await settled();
  for (let attempt = 0; attempt < 3; attempt++)
    await expect(retry()).rejects.toThrow(/no such file/);
  expect(new Set(keys)).toMatchObject({ size: 1 });
});

test("WORKAROUND, under load: every caller that finds the id dead while its recovery runs waits on that one recovery — 50 concurrent callers run the producer once, not 50 times", async () => {
  // prd, 2026-09-24 14:36 UTC: the config worker's first load after a deploy failed, a scanner sent
  // 4,502 requests in 31 s, and each ran its own producer — ~915 `repo.modules` calls at once.
  const { env, keys } = fakeLoaderEnv();
  const host = {} as Fetcher; // a context's one `itxEntrypoint` stub per incarnation
  let produced = 0;
  let failFirst = true;
  let release!: () => void;
  const slow = new Promise<void>((resolve) => (release = resolve));
  const invoke = async () => {
    produced++;
    if (failFirst) {
      failFirst = false;
      throw new Error("Network connection lost.");
    }
    await slow; // a cold repo fetch: 1–2 s on prd, 40–60 s under the herd
    return { "worker.js": "export default class Site {}" };
  };
  const load = (itxEntrypoint = host) =>
    loadConfined(env, {
      itxEntrypoint,
      source: ["itx", "repos", ["get", "/repos/config"], ["modules", { commitOid: "c0ffee" }]],
      cacheKey: "c0ffee",
      invoke,
    });
  const dead = JSON.stringify(["worker", "deploy-1", null, "prj_u.iterate/", "c0ffee"]);
  await load(); // the first load's producer throws inside getCode: the id is dead
  await settled();
  expect(produced).toBe(1);
  const herd = Array.from({ length: 50 }, () => load());
  await settled();
  expect(produced).toBe(2); // one recovery, however many callers
  release();
  const recovered = await Promise.all(herd);
  expect(new Set(recovered.map((r) => r.loaderId))).toEqual(new Set([`${dead}#1`]));
  expect(produced).toBe(2);
  expect(new Set(keys)).toEqual(new Set([dead, `${dead}#1`]));
});

test("WORKAROUND, under load: a recovery that fails fails every caller waiting on it, and the next caller starts a fresh one; a recovery another incarnation started is never waited on", async () => {
  const { env } = fakeLoaderEnv();
  let produced = 0;
  let outcome: "fail" | "hang" | "ok" = "fail";
  const invoke = async () => {
    produced++;
    if (outcome === "fail") throw new Error("Durable Object is overloaded.");
    if (outcome === "hang") return new Promise<never>(() => {}); // its incarnation died mid-call
    return { "worker.js": "export default class Site {}" };
  };
  const load = (itxEntrypoint: Fetcher) =>
    loadConfined(env, {
      itxEntrypoint,
      owner: "prj_v.iterate/",
      source: "itx.build('site')",
      cacheKey: "site@1",
      invoke,
    });
  const incarnation1 = {} as Fetcher;
  await load(incarnation1); // dies inside getCode
  await settled();
  // a failing recovery: every caller waiting on it fails with it, the producer ran once for them
  const failing = await Promise.allSettled([load(incarnation1), load(incarnation1)]);
  expect(failing.map((r) => r.status)).toEqual(["rejected", "rejected"]);
  expect(produced).toBe(2);
  // an incarnation that dies with its recovery in flight leaves a promise that never settles …
  outcome = "hang";
  void load(incarnation1);
  await settled();
  expect(produced).toBe(3);
  // … and the next incarnation (a new stub) starts its own instead of waiting on it forever
  outcome = "ok";
  const incarnation2 = {} as Fetcher;
  await expect(load(incarnation2)).resolves.toMatchObject({
    loaderId: `${JSON.stringify(["worker", "deploy-1", null, "prj_v.iterate/", "site@1"])}#1`,
  });
  expect(produced).toBe(4);
});

test("retire(): a burst of calls that failed on one identity retires it once, and a late retire from a replaced identity never sends the next generation back to it", async () => {
  const { env } = fakeLoaderEnv();
  const opts = workerOptions(env, {
    owner: "prj_retire.iterate/",
    source: { "worker.js": "export default {}" },
  });
  // two calls on generation 0 meet the clone-version failure together: one retirement
  const [a, b] = await Promise.all([prepareConfinedWorker(opts), prepareConfinedWorker(opts)]);
  a.retire();
  b.retire();
  const recovered = await prepareConfinedWorker(opts);
  expect(recovered).toMatchObject({ loaderId: `${a.loaderId}#1` });
  // generation 1 fails too; a call still in flight on generation 0 fails late
  recovered.retire();
  a.retire();
  expect(await prepareConfinedWorker(opts)).toMatchObject({ loaderId: `${a.loaderId}#2` });
});

test("prepare resolves the identity without asking the loader; load() is the one call that does, and a repeat is the loader's cache to answer", async () => {
  const { env, keys, warm } = fakeLoaderEnv();
  const prepared = await prepareConfinedWorker(
    workerOptions(env, {
      kind: "facet",
      owner: ["prj_u.iterate/", "Counter"],
      source: { "worker.js": "export default class Counter {}" },
      where: 'facet "counter"',
    }),
  );
  expect(keys).toEqual([]); // `FacetHost#callFacet` stores this identity before any isolate exists
  // the stored restart marker: respelling it restarts every facet once on its next wake
  expect(JSON.parse(prepared.loaderId)).toEqual([
    "facet",
    "deploy-1",
    null,
    ["prj_u.iterate/", "Counter"],
    expect.stringMatching(/^[0-9a-z]+-[0-9a-z]+-[0-9a-z]+$/),
  ]);
  prepared.load();
  expect(keys).toEqual([prepared.loaderId]);
  prepared.load();
  expect(keys).toEqual([prepared.loaderId, prepared.loaderId]);
  expect(warm).toMatchObject({ size: 1 }); // one isolate under the id, however often it is asked for
});

test("a facet's literal source over the ceiling is refused, coded; a producer expression is never measured", () => {
  const big = { "worker.js": "x".repeat(FACET_SOURCE_MAX_CHARS + 1) };
  expect(() =>
    assertFacetSourceWithinCeiling({ source: big, className: "W" }, 'facet "w"'),
  ).toThrowError(/FACET_SOURCE_TOO_LARGE|over the/);
  expect(() =>
    assertFacetSourceWithinCeiling({ source: { "worker.js": "ok" }, className: "W" }, 'facet "w"'),
  ).not.toThrow();
  expect(() =>
    assertFacetSourceWithinCeiling(
      { source: "itx.kv.get('src')", cacheKey: "v1", className: "W" },
      'facet "w"',
    ),
  ).not.toThrow();
});

test("the platform origin the ITX stub was minted with is part of the loader id: an isolate minted before a self-host learned its origin is never reused after", async () => {
  const { env } = fakeLoaderEnv();
  const opts = workerOptions(env, { source: { "worker.js": "export default class A {}" } });
  const before = await prepareConfinedWorker({ ...opts, platformOrigin: null });
  const after = await prepareConfinedWorker({ ...opts, platformOrigin: "https://os.example" });
  const again = await prepareConfinedWorker({ ...opts, platformOrigin: "https://os.example" });
  expect(before).not.toMatchObject({ loaderId: after.loaderId });
  expect(again).toMatchObject({ loaderId: after.loaderId });
});

/** A fake `env.LOADER` that records every key and — like workerd — runs `getCode` once per NEW key
 *  and keeps whatever came of it under the key, a rejection included (a handler is attached so a
 *  rejection kept in `warm` is not an unhandled one). */
const fakeLoaderEnv = () => {
  const keys: string[] = [];
  const warm = new Map<string, Promise<unknown>>();
  const env = {
    LOADER: {
      get: (key: string, getCode: () => Promise<unknown>) => {
        keys.push(key);
        if (!warm.has(key)) {
          const code = getCode();
          code.catch(() => undefined);
          warm.set(key, code);
        }
        return {};
      },
    },
  } as unknown as Parameters<typeof prepareConfinedWorker>[0]["env"];
  return { env, keys, warm };
};

type ConfinedWorkerOptions = Parameters<typeof prepareConfinedWorker>[0];

/** A confined worker's options over `env`: a worker of `prj_u.iterate/` on deploy-1 with no platform
 *  origin, a fresh `itxEntrypoint` stand-in (the one cast) and literal modules nothing invokes, with
 *  what a row varies in `overrides`. */
const workerOptions = (
  env: ConfinedWorkerOptions["env"],
  overrides: Partial<ConfinedWorkerOptions> & Pick<ConfinedWorkerOptions, "source">,
): ConfinedWorkerOptions => ({
  env,
  deployId: "deploy-1",
  platformOrigin: null,
  itxEntrypoint: {} as Fetcher,
  kind: "worker",
  owner: "prj_u.iterate/",
  invoke: () => Promise.reject(new Error("literal modules — nothing to invoke")),
  where: "workers.get",
  ...overrides,
});

/** Prepare AND load at once — the shape `itx.workers.get` takes; the rows above count what reached
 *  `env.LOADER`, and only `load()` reaches it. */
const loadConfined = async (...args: Parameters<typeof workerOptions>) => {
  const prepared = await prepareConfinedWorker(workerOptions(...args));
  prepared.load();
  return prepared;
};

/** Let every promise chain started so far settle (a producer's failure reaches the dead marker
 *  through the resolve step's awaits), whatever its depth in microtasks. */
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
