// context/worker-loader.test.ts — the Worker Loader id is an authority boundary (two callers who
// compose one id share an isolate), a producer runs inside `getCode`, the dead-id WORKAROUND
// (worker-loader.ts `loaderIdGenerations`), and `workers.get`'s recovery from the loader defect
// (built-ins.ts), over a fake loader; the real one is the Workers suite's.
import type { ItxExpression, ItxExpressionStep } from "iterate/expression";
import { codedError, errorCode } from "iterate/lib";
import { failureKind } from "iterate/platform-retry";
import { expect, test, vi } from "vitest";
import { workersRoot } from "./built-ins.ts";
import { SOURCE_MAX_CHARS } from "./itx-expression-rewriting.ts";
import { DurableObjectNameCodec } from "./paths.ts";
import {
  assertFacetSourceWithinCeiling,
  isLoadedWorkerPlatformFailure,
  prepareConfinedWorker,
} from "./worker-loader.ts";

test("two literal sources whose djb2 hashes collide never share one Worker Loader cacheKey", async () => {
  // djb2("Aa") === djb2("B@") — one 32-bit hash, two sources.
  const { env, keys } = fakeLoaderEnv();
  await loadConfined(env, {
    source: { "package.json": '{"main":"worker.js"}', "worker.js": "Aa" },
  });
  await loadConfined(env, {
    source: { "package.json": '{"main":"worker.js"}', "worker.js": "B@" },
  });
  expect(new Set(keys)).toMatchObject({ size: 2 });
});

test("an owner and a caller's cacheKey that concatenate alike never share one Worker Loader cacheKey", async () => {
  // owner "…/x" + key "y:z" vs owner "…/x:y" + key "z": joined with ":" they would spell ONE id.
  const { env, keys } = fakeLoaderEnv();
  const source = {
    "package.json": '{"main":"worker.js"}',
    "worker.js": "export default class W {}",
  };
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
  const modules = {
    "package.json": '{"main":"worker.js"}',
    "worker.js": "export default class Tally {}",
  };
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
    return { "package.json": '{"main":"worker.js"}', "worker.js": "export default class Built {}" };
  };
  const load = (cacheKey?: string) =>
    loadConfined(env, { source: "itx.build('todo')", cacheKey, invoke });
  // refused without a key: hashing the expression would be the stale-code trap
  await expect(load()).rejects.toThrow(/needs a cacheKey/);
  expect(produced).toBe(0);
  // with a key: the producer runs when the key is cold …
  const first = await load("todo@3f2a1c");
  expect(first).toMatchObject({
    loaderId: JSON.stringify(["worker", "deploy-1", null, "prj_u.iterate/", "key:todo@3f2a1c"]),
  });
  expect(keys.at(-1)).toBe(first.loaderId);
  await vi.waitFor(() => expect(produced).toBe(1)); // getCode's async body runs, its key digested first
  // … and NOT when it is warm — "same key ⇒ same code" is the caller's contract
  await load("todo@3f2a1c");
  await settled();
  expect(produced).toBe(1);
  // a new key is a new isolate: the producer runs again
  await load("todo@4b7d");
  await vi.waitFor(() => expect(produced).toBe(2));
});

test("a producer's modules are read once per commit, not once per cold isolate: a cold isolate under the same key reads ITX_KV and never asks the producer again", async () => {
  const { kv } = fakeKv();
  const producer = fakeProducer();
  const coldIsolate = async () => {
    const { env, warm } = fakeLoaderEnv({ kv }); // the last isolate idled out: nothing warm
    const { loaderId } = await loadConfined(env, {
      owner: "prj_kv_cold.iterate/",
      source: site,
      cacheKey: "c0ffee",
      ...producer,
    });
    return warm.get(loaderId);
  };
  await expect(coldIsolate()).resolves.toMatchObject({
    modules: { "worker.js": loaded("export default 1") },
  });
  expect(producer.produced()).toBe(1);
  await expect(coldIsolate()).resolves.toMatchObject({
    modules: { "worker.js": loaded("export default 1") },
  });
  expect(producer.produced()).toBe(1);
});

test("what a producer answered is kept for a day under its deploy, owner, key and expression: no other caller reads it", async () => {
  const shared = fakeKv();
  const producer = fakeProducer();
  const load = (overrides: Partial<ConfinedWorkerOptions> = {}) =>
    loadConfined(fakeLoaderEnv({ kv: shared.kv }).env, {
      owner: "prj_kv_scope.iterate/",
      source: site,
      cacheKey: "c0ffee",
      ...producer,
      ...overrides,
    });
  await load();
  await vi.waitFor(() => expect(shared.puts).toHaveLength(1));
  expect(shared).toMatchObject({
    puts: [
      { key: expect.stringMatching(/^produced-modules-1\//), options: { expirationTtl: 86_400 } },
    ],
  });
  const others: Partial<ConfinedWorkerOptions>[] = [
    { owner: "prj_other.iterate/" },
    { deployId: "deploy-2" },
    { cacheKey: "decade" },
    { source: ["itx", "repos", ["get", "/repos/config"], ["modules", { commitOid: "decade" }]] },
  ];
  for (const other of others) {
    const before = producer.produced();
    await load(other);
    await vi.waitFor(() => expect(producer.produced()).toBe(before + 1));
  }
  expect(new Set(shared.puts.map((put) => put.key))).toMatchObject({ size: 5 });
});

test("a KV that cannot be read or written costs the producer's run and a logged warning, never the load", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const broken = {
    get: () => Promise.reject(new Error("KV GET failed")),
    put: () => Promise.reject(new Error("KV PUT failed")),
  } as unknown as KVNamespace;
  const { env, warm } = fakeLoaderEnv({ kv: broken });
  const producer = fakeProducer();
  const { loaderId } = await loadConfined(env, {
    owner: "prj_kv_broken.iterate/",
    source: site,
    cacheKey: "c0ffee",
    ...producer,
  });
  await expect(warm.get(loaderId)).resolves.toMatchObject({
    modules: { "worker.js": loaded("export default 1") },
  });
  expect(warn.mock.calls.map(([line]) => line)).toMatchObject([
    { event: "worker-loader.platform-failure-module-cache", action: "get" },
    { event: "worker-loader.platform-failure-module-cache", action: "put" },
  ]);
});

test("an answer that cannot load is never kept or believed: the dead-id recovery asks the producer again", async () => {
  const owner = "prj_kv_unloadable.iterate/";
  const shared = fakeKv();
  const { env, warm } = fakeLoaderEnv({ kv: shared.kv });
  let produced = 0;
  const invoke = async () =>
    ++produced === 1
      ? {} // the build has not landed: no entry
      : { "package.json": '{"main":"worker.js"}', "worker.js": "export default class Site {}" };
  const load = () => loadConfined(env, { owner, source: site, cacheKey: "c0ffee", invoke });
  const first = await load();
  await expect(warm.get(first.loaderId)).rejects.toThrow(/no entry/);
  expect(shared).toMatchObject({ puts: [] });
  const recovered = await load();
  await expect(warm.get(recovered.loaderId)).resolves.toMatchObject({
    modules: { "worker.js": loaded("export default class Site {}") },
  });
  expect(produced).toBe(2);
  expect(shared.puts).toHaveLength(1);
  // a value under the key that is not a loadable module map is a miss, and the producer's answer replaces it
  for (const key of shared.values.keys()) shared.values.set(key, "{}");
  const cold = fakeLoaderEnv({ kv: shared.kv });
  await loadConfined(cold.env, { owner, source: site, cacheKey: "c0ffee", invoke });
  await vi.waitFor(() => expect(produced).toBe(3));
});

test("an answer over KV's value limit is not kept, and costs no warning: the worker still loads", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const shared = fakeKv();
  const { env, warm } = fakeLoaderEnv({ kv: shared.kv });
  const invoke = async () => ({
    "package.json": '{"main":"worker.js"}',
    "worker.js": "export default class Site {}",
    "assets/big.txt": "x".repeat(26 * 1024 * 1024),
  });
  const { loaderId } = await loadConfined(env, {
    owner: "prj_kv_oversize.iterate/",
    source: site,
    cacheKey: "c0ffee",
    invoke,
  });
  await expect(warm.get(loaderId)).resolves.toMatchObject({
    modules: { "worker.js": loaded("export default class Site {}") },
  });
  expect(shared).toMatchObject({ puts: [] });
  expect(warn).not.toHaveBeenCalled();
});

test("literal modules: the key is their content hash unless the caller names a cacheKey", async () => {
  const { env, keys } = fakeLoaderEnv();
  const a = await loadConfined(env, {
    source: { "package.json": '{"main":"worker.js"}', "worker.js": "export default 1" },
  });
  const b = await loadConfined(env, {
    source: { "package.json": '{"main":"worker.js"}', "worker.js": "export default 2" },
  });
  expect(a).not.toMatchObject({ loaderId: b.loaderId }); // content decides
  const named = await loadConfined(env, {
    source: { "package.json": '{"main":"worker.js"}', "worker.js": "export default 1" },
    cacheKey: "v7",
  });
  expect(named).toMatchObject({
    loaderId: JSON.stringify(["worker", "deploy-1", null, "prj_u.iterate/", "key:v7"]),
  });
  expect(keys.at(-1)).toBe(named.loaderId);
  await expect(loadConfined(env, { source: { "lib.js": "export default 1" } })).rejects.toThrow(
    /no entry/,
  );
});

test("a main module is one more element of the key, and a module identity names the code in place of the cacheKey: every source that answers it loads the same code for that module", async () => {
  const { env } = fakeLoaderEnv();
  const source = "itx.repos.get('/repos/config').modules()";
  // the id past its kind, deploy, origin and owner
  const keyOf = async (cacheKey: string, moduleIdentity?: string) => {
    const options = workerOptions(env, {
      source,
      cacheKey,
      mainModule: "agents.ts",
      moduleIdentity,
    });
    return JSON.parse((await prepareConfinedWorker(options)).loaderId).slice(4);
  };
  expect(await keyOf("commit-1")).toEqual(["key:commit-1", "agents.ts"]);
  // two commits whose agents.ts is one identity: one isolate identity
  expect(await keyOf("commit-1", "a1")).toEqual(["module:a1", "agents.ts"]);
  expect(await keyOf("commit-2", "a1")).toEqual(["module:a1", "agents.ts"]);
  // a cacheKey spelled as that identity is still a cacheKey: it never takes the module's id
  expect(await keyOf("a1")).toEqual(["key:a1", "agents.ts"]);
});

test("WORKAROUND: a producer that threw marks its id dead; the next attempt produces OUTSIDE the loader and loads literally under the id's next generation; a producer that keeps failing mints nothing", async () => {
  const { env, keys, warm } = fakeLoaderEnv();
  let artifactLanded = false;
  let produced = 0;
  const invoke = async () => {
    produced++;
    if (!artifactLanded) throw new Error("build artifact not landed yet");
    return { "package.json": '{"main":"worker.js"}', "worker.js": "export default class Built {}" };
  };
  const load = () =>
    loadConfined(env, { source: "itx.build('todo')", cacheKey: "todo@dead", invoke });
  // 1. the producer throws INSIDE getCode — workerd keeps that rejection under the id forever
  const first = await load();
  expect(first).toMatchObject({
    loaderId: JSON.stringify(["worker", "deploy-1", null, "prj_u.iterate/", "key:todo@dead"]),
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
    loaderId: expect.stringContaining(
      `${JSON.stringify(["worker", "deploy-1", null, "prj_u.iterate/", "key:todo@dead"])}#1.`,
    ),
  });
  await expect(warm.get(recovered.loaderId)).resolves.toMatchObject({
    modules: { "worker.js": loaded("export default class Built {}") },
  });
  expect(produced).toBe(4);
  // 4. …and from here the generation is warm: no producer run, no new id
  await load();
  expect(produced).toBe(4);
  expect(new Set(keys)).toMatchObject({ size: 2 }); // the dead id and its one recovered generation
});

test("a source that keeps failing to resolve mints one loader id, not one per retry: the recovery resolves outside the loader", async () => {
  const { env, keys } = fakeLoaderEnv();
  const retry = () =>
    loadConfined(env, {
      source: { "package.json": '{"main":"worker.js"}', "worker.js": `import "./missing.js";` },
    });
  await retry(); // the cold load resolves inside getCode, fails, and marks the id dead
  await settled();
  for (let attempt = 0; attempt < 3; attempt++)
    await expect(retry()).rejects.toThrow(/no such file/);
  expect(new Set(keys)).toMatchObject({ size: 1 });
});

test("WORKAROUND, under load: every caller that finds the id dead while its recovery runs waits on that one recovery — 50 concurrent callers run the producer once, not 50 times", async () => {
  // prd, 2026-09-24 14:36 UTC: the config worker's first load after a deploy failed, a scanner sent
  // 4,502 requests in 31 s, and each ran its own producer — ~915 `repo.modules` calls at once.
  const { env, keys, warm } = fakeLoaderEnv();
  const host = {} as Fetcher; // a context's one `itxEntrypoint` stub per incarnation
  let produced = 0;
  let failures = 2;
  let release!: () => void;
  const slow = new Promise<void>((resolve) => (release = resolve));
  const invoke = async () => {
    produced++;
    if (failures > 0) {
      failures--;
      throw new Error("Network connection lost.");
    }
    await slow; // a cold repo fetch: 1–2 s on prd, 40–60 s under the herd
    return { "package.json": '{"main":"worker.js"}', "worker.js": "export default class Site {}" };
  };
  const load = (itxEntrypoint = host) =>
    loadConfined(env, {
      itxEntrypoint,
      source: ["itx", "repos", ["get", "/repos/config"], ["modules", { commitOid: "c0ffee" }]],
      cacheKey: "c0ffee",
      invoke,
    });
  const dead = JSON.stringify(["worker", "deploy-1", null, "prj_u.iterate/", "key:c0ffee"]);
  // the first load's producer loses its connection, and again on its one repeat, inside getCode:
  // the id is dead
  await load();
  await expect(warm.get(dead)).rejects.toThrow(/Network connection lost/);
  expect(produced).toBe(2);
  const herd = Array.from({ length: 50 }, () => load());
  await vi.waitFor(() => expect(produced).toBe(3));
  await settled();
  expect(produced).toBe(3); // one recovery, however many callers
  release();
  const recovered = await Promise.all(herd);
  const [recoveredId, ...others] = new Set(recovered.map((r) => r.loaderId));
  expect({ recoveredId, others }).toEqual({
    recoveredId: expect.stringContaining(`${dead}#1.`),
    others: [],
  });
  expect(produced).toBe(3);
  expect(new Set(keys)).toEqual(new Set([dead, recoveredId]));
});

test("a producer that loses its connection once inside getCode is read once more, and the id stays live: no dead mark, no next generation", async () => {
  const { env, keys, warm } = fakeLoaderEnv();
  let produced = 0;
  const invoke = async () => {
    produced++;
    if (produced === 1) throw new Error("Network connection lost.");
    return { "package.json": '{"main":"worker.js"}', "worker.js": "export default class Site {}" };
  };
  const load = () =>
    loadConfined(env, {
      owner: "prj_lost_once.iterate/",
      source: "itx.build('site')",
      cacheKey: "site@lost-once",
      invoke,
    });
  const first = await load();
  await expect(warm.get(first.loaderId)).resolves.toMatchObject({
    modules: { "worker.js": loaded("export default class Site {}") },
  });
  expect(produced).toBe(2);
  // warm under the same id: the lost connection marked nothing dead
  await expect(load()).resolves.toMatchObject({ loaderId: first.loaderId });
  expect(produced).toBe(2);
  expect(new Set(keys)).toEqual(new Set([first.loaderId]));
});

test("WORKAROUND, under load: a recovery that fails fails every caller waiting on it, and the next caller starts a fresh one; a recovery another incarnation started is never waited on", async () => {
  const { env } = fakeLoaderEnv();
  let produced = 0;
  let outcome: "fail" | "hang" | "ok" = "fail";
  const invoke = async () => {
    produced++;
    if (outcome === "fail") throw new Error("Durable Object is overloaded.");
    if (outcome === "hang") return new Promise<never>(() => {}); // its incarnation died mid-call
    return { "package.json": '{"main":"worker.js"}', "worker.js": "export default class Site {}" };
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
  await vi.waitFor(() => expect(produced).toBe(1));
  await settled();
  // a failing recovery: every caller waiting on it fails with it, the producer ran once for them
  const failing = await Promise.allSettled([load(incarnation1), load(incarnation1)]);
  expect(failing.map((r) => r.status)).toEqual(["rejected", "rejected"]);
  expect(produced).toBe(2);
  // an incarnation that dies with its recovery in flight leaves a promise that never settles …
  outcome = "hang";
  void load(incarnation1);
  await vi.waitFor(() => expect(produced).toBe(3));
  // … and the next incarnation (a new stub) starts its own instead of waiting on it forever
  outcome = "ok";
  const incarnation2 = {} as Fetcher;
  await expect(load(incarnation2)).resolves.toMatchObject({
    loaderId: expect.stringContaining(
      `${JSON.stringify(["worker", "deploy-1", null, "prj_v.iterate/", "key:site@1"])}#1.`,
    ),
  });
  expect(produced).toBe(4);
});

test("retire(): a burst of calls that failed on one identity retires it once, and a late retire from a replaced identity never sends the next generation back to it", async () => {
  const { env } = fakeLoaderEnv();
  const opts = workerOptions(env, {
    owner: "prj_retire.iterate/",
    source: { "package.json": '{"main":"worker.js"}', "worker.js": "export default {}" },
  });
  // two calls on generation 0 meet the clone-version failure together: one retirement
  const [a, b] = await Promise.all([prepareConfinedWorker(opts), prepareConfinedWorker(opts)]);
  a.retire();
  b.retire();
  const recovered = await prepareConfinedWorker(opts);
  expect(recovered).toMatchObject({ loaderId: expect.stringContaining(`${a.loaderId}#1.`) });
  // generation 1 fails too; a call still in flight on generation 0 fails late
  recovered.retire();
  a.retire();
  expect(await prepareConfinedWorker(opts)).toMatchObject({
    loaderId: expect.stringContaining(`${a.loaderId}#2.`),
  });
});

test("two isolates that retire one identity load its next generation under two ids, never each other's entry", async () => {
  // The Worker Loader shares an entry by id across a machine's isolates, and each isolate, its own
  // evaluation of worker-loader.ts, counts generations from 0.
  const opts = workerOptions(fakeLoaderEnv().env, {
    owner: "prj_two_isolates.iterate/",
    source: { "package.json": '{"main":"worker.js"}', "worker.js": "export default {}" },
  });
  vi.resetModules();
  const sibling = await import("./worker-loader.ts");
  const nextGenerationIn = async (isolate: Pick<typeof sibling, "prepareConfinedWorker">) => {
    (await isolate.prepareConfinedWorker(opts)).retire();
    return (await isolate.prepareConfinedWorker(opts)).loaderId;
  };
  const base = (await prepareConfinedWorker(opts)).loaderId;
  const ids = [await nextGenerationIn({ prepareConfinedWorker }), await nextGenerationIn(sibling)];
  expect(new Set(ids)).toMatchObject({ size: 2 });
  expect(ids).toEqual([
    expect.stringContaining(`${base}#1.`),
    expect.stringContaining(`${base}#1.`),
  ]);
});

test("prepare resolves the identity without asking the loader; load() is the one call that does, and a repeat is the loader's cache to answer", async () => {
  const { env, keys, warm } = fakeLoaderEnv();
  const prepared = await prepareConfinedWorker(
    workerOptions(env, {
      kind: "facet",
      owner: ["prj_u.iterate/", "Counter"],
      source: {
        "package.json": '{"main":"worker.js"}',
        "worker.js": "export default class Counter {}",
      },
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
    expect.stringMatching(/^content:[0-9a-z]+-[0-9a-z]+-[0-9a-z]+$/),
  ]);
  prepared.load();
  expect(keys).toEqual([prepared.loaderId]);
  prepared.load();
  expect(keys).toEqual([prepared.loaderId, prepared.loaderId]);
  expect(warm).toMatchObject({ size: 1 }); // one isolate under the id, however often it is asked for
});

test("a facet's literal source over the ceiling is refused, coded; a producer expression is never measured", () => {
  const big = {
    "package.json": '{"main":"worker.js"}',
    "worker.js": "x".repeat(SOURCE_MAX_CHARS + 1),
  };
  expect(() =>
    assertFacetSourceWithinCeiling({ source: big, className: "W" }, 'facet "w"'),
  ).toThrowError(/FACET_SOURCE_TOO_LARGE|over the/);
  expect(() =>
    assertFacetSourceWithinCeiling(
      { source: { "package.json": '{"main":"worker.js"}', "worker.js": "ok" }, className: "W" },
      'facet "w"',
    ),
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
  const opts = workerOptions(env, {
    source: { "package.json": '{"main":"worker.js"}', "worker.js": "export default class A {}" },
  });
  const before = await prepareConfinedWorker({ ...opts, platformOrigin: null });
  const after = await prepareConfinedWorker({ ...opts, platformOrigin: "https://os.example" });
  const again = await prepareConfinedWorker({ ...opts, platformOrigin: "https://os.example" });
  expect(before).not.toMatchObject({ loaderId: after.loaderId });
  expect(again).toMatchObject({ loaderId: after.loaderId });
});

// The Worker Loader defect's two spellings, and every look-alike that is not it: code's own error,
// an overload, a coded hop.
test.for([
  {
    name: "V8's clone-version text",
    error: new Error("Unable to deserialize cloned data due to invalid or unsupported version."),
    retired: true,
  },
  {
    name: "the runtime's opaque internal error",
    error: new Error("internal error; reference = h0v550femca1l7qboin7l1f1"),
    retired: true,
  },
  {
    name: "the same text thrown by the loaded code (remote)",
    error: Object.assign(new Error("internal error; reference = h0v550femca1l7qboin7l1f1"), {
      remote: true,
    }),
    retired: false,
  },
  {
    name: "an overload the runtime spelled opaquely",
    error: Object.assign(new Error("internal error; reference = h0v550femca1l7qboin7l1f1"), {
      overloaded: true,
    }),
    retired: false,
  },
  {
    name: "a hop below's coded failure carrying the opaque text",
    error: codedError("UNAVAILABLE", "internal error; reference = h0v550femca1l7qboin7l1f1", {
      kind: "disconnected",
    }),
    retired: false,
  },
  { name: "a lost connection", error: new Error("Network connection lost."), retired: false },
  { name: "the loaded code's own failure", error: new Error("recipe: 503"), retired: false },
  { name: "not an Error", error: "internal error; reference = x", retired: false },
])("isLoadedWorkerPlatformFailure: $name → $retired", ({ error, retired }) => {
  expect(isLoadedWorkerPlatformFailure(error)).toBe(retired);
});

// `workers.get` over a loader whose first `failingEntries` entries fail every call with `failure`,
// then one more GET: what each call settled as, and the generation of every entry it was served.
const defect = new Error("internal error; reference = defect");
const unavailable = {
  rejected: {
    code: "UNAVAILABLE",
    kind: "disconnected",
    message: "workers.get(spec).fetch: internal error; reference = defect",
  },
};
test.for([
  {
    name: "a GET the defect fails is replayed once, on the next generation, and answers",
    step: ["fetch", new Request("https://site.test/")],
    failingEntries: 1,
    failure: defect,
    expected: { first: { answered: "GET" }, next: { answered: "GET" }, generations: [0, 1, 1] },
  },
  {
    name: "a GET whose replay the defect fails too is UNAVAILABLE, disconnected: a 503 with Retry-After",
    step: ["fetch", new Request("https://site.test/")],
    failingEntries: 2,
    failure: defect,
    expected: { first: unavailable, next: { answered: "GET" }, generations: [0, 1, 2] },
  },
  {
    name: "a POST the defect fails is never replayed: UNAVAILABLE, and the next call loads fresh",
    step: ["fetch", new Request("https://site.test/", { method: "POST", body: "form=1" })],
    failingEntries: 1,
    failure: defect,
    expected: { first: unavailable, next: { answered: "GET" }, generations: [0, 1] },
  },
  {
    name: "an RPC method the defect fails is never replayed: UNAVAILABLE, and the next call loads fresh",
    step: ["hello"],
    failingEntries: 1,
    failure: defect,
    expected: {
      first: {
        rejected: {
          ...unavailable.rejected,
          message: "workers.get(spec).hello: internal error; reference = defect",
        },
      },
      next: { answered: "GET" },
      generations: [0, 1],
    },
  },
  {
    name: "the loaded code's own failure is its own: no retire, no replay, not recoded",
    step: ["fetch", new Request("https://site.test/")],
    failingEntries: 1,
    failure: Object.assign(new Error("internal error; reference = thrown-by-code"), {
      remote: true,
    }),
    expected: {
      first: {
        rejected: { kind: "failed", message: "internal error; reference = thrown-by-code" },
      },
      next: {
        rejected: { kind: "failed", message: "internal error; reference = thrown-by-code" },
      },
      generations: [0, 0],
    },
  },
] satisfies { step: ItxExpressionStep; [key: string]: unknown }[])(
  "workers.get and the loader defect: $name",
  async ({ step, failingEntries, failure, expected }) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { call, generations } = workersGetOverFailingLoader(failingEntries, failure);
    const first = await settle(call(step));
    const next = await settle(call(["fetch", new Request("https://site.test/")]));
    expect({ first, next, generations }).toEqual(expected);
  },
);

/** The site ingress's producer expression: the config repo's tree at one commit. */
const site: ItxExpression = [
  "itx",
  "repos",
  ["get", "/repos/config"],
  ["modules", { commitOid: "c0ffee" }],
];

/** A producer that answers valid modules and counts its runs. */
const fakeProducer = () => {
  let produced = 0;
  return {
    produced: () => produced,
    invoke: async () => ({
      "package.json": '{"main":"worker.js"}',
      "worker.js": `export default ${++produced}`,
    }),
  };
};

/** A fake `env.ITX_KV` that keeps every value and records each `put`'s options. */
const fakeKv = () => {
  const values = new Map<string, string>();
  const puts: { key: string; options?: KVNamespacePutOptions }[] = [];
  const kv = {
    get: async (key: string, type?: "json") => {
      const value = values.get(key) ?? null;
      return type === "json" && value ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string, options?: KVNamespacePutOptions) => {
      values.set(key, value);
      puts.push({ key, options });
    },
  } as unknown as KVNamespace;
  return { kv, values, puts };
};

/** A fake `env.LOADER` that records every key and — like workerd — runs `getCode` once per NEW key
 *  and keeps whatever came of it under the key, a rejection included (a handler is attached so a
 *  rejection kept in `warm` is not an unhandled one). Its `ITX_KV` is a fresh fake unless a row
 *  shares one across two fake loaders: two isolate lifetimes of ONE platform. */
const fakeLoaderEnv = ({ kv = fakeKv().kv }: { kv?: KVNamespace } = {}) => {
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
    ITX_KV: kv,
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

/** `itx.workers.get(spec)` of a fresh context, one `call(step)` per call, over a Worker Loader whose
 *  first `failingEntries` entries (by id, in the order it was asked for them) reject every call with
 *  `failure`, and whose later ones answer: a fetch with its request's method, an RPC `hello` with
 *  "hello". `generations` is the generation of each entry a call was served, in order. */
const workersGetOverFailingLoader = (failingEntries: number, failure: Error) => {
  const entries: string[] = [];
  const generations: number[] = [];
  const env = {
    LOADER: {
      get: (id: string) => {
        if (!entries.includes(id)) entries.push(id);
        generations.push(Number(/#(\d+)\.[0-9a-f]{8}$/.exec(id)?.[1] ?? 0));
        const answer = async (value: string) => {
          if (entries.indexOf(id) < failingEntries) throw failure;
          return value;
        };
        return {
          getEntrypoint: () => ({
            fetch: async (request: Request) => new Response(await answer(request.method)),
            hello: () => answer("hello"),
          }),
        };
      },
    },
    ITX_KV: fakeKv().kv,
  } as unknown as ConfinedWorkerOptions["env"];
  const itxEntrypoint = {} as Fetcher; // one stub per context incarnation, as the platform mints it
  const workers = workersRoot({
    env,
    deployId: "deploy-1",
    projectId: "prj_u",
    path: "/",
    iterateContextName: `prj_u.iterate/${crypto.randomUUID()}`,
    platformOrigin: () => null,
    itxEntrypoint: () => itxEntrypoint,
    invoke: () => Promise.reject(new Error("literal modules — nothing to invoke")),
    caller: () => ({ principal: null, app: true }),
    delivery: () => undefined,
    cause: () => undefined,
    namedWorker: () => Promise.reject(new Error("a literal source names no worker")),
  });
  const source = { "package.json": '{"main":"worker.js"}', "worker.js": "export default {}" };
  return {
    generations,
    call: (step: ItxExpressionStep) => workers.get({ source }).invoke([step]),
  };
};

/** What a call settled as: a Response's text or the value it answered, or the failure's code, kind
 *  and message. */
const settle = (call: unknown) =>
  Promise.resolve(call).then(
    async (answer) => ({ answered: answer instanceof Response ? await answer.text() : answer }),
    (error: unknown) => ({
      rejected: {
        code: errorCode(error),
        kind: failureKind(error),
        message: error instanceof Error ? error.message : String(error),
      },
    }),
  );

/** An author's main module as the loader starts it: the platform's module imported first. */
const loaded = (code: string) => `import "./node_modules/.platform/loaded-worker.js"; ${code}`;
