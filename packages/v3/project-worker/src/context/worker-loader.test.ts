// context/worker-loader.test.ts — the Worker Loader cacheKey is an AUTHORITY boundary: the
// isolate's whole world (its env.ITX host stub, its globalOutbound) is baked in at first
// materialization, so two callers who compose the same key SHARE an isolate. loadConfinedWorker
// mints `${kind}:${deploy}:${owner}:${sourceVersion}` (the caller's cacheKey, else the modules'
// content hash); a facet's owner is (context name, class name), and either half may contain ":" (a
// context path is any string; ES2022 allows `export { X as "y:Door" }`). `facetLoaderOwner`
// length-prefixes the context so the split is unambiguous whatever either half contains. The second
// half pins Cloudflare's `get(id, getCode)` contract as we use it: a PRODUCER expression runs inside
// `getCode` (a cold isolate only) and is refused without a cacheKey. The last row pins the workerd
// WORKAROUND (worker-loader.ts `loaderIdGenerations`): a producer that threw marks its id dead, the
// next attempt produces outside the loader and loads literally under the id's next generation.
import { expect, test } from "vitest";
import { DurableObjectNameCodec } from "./durable-object-names.ts";
import { facetLoaderOwner, loadConfinedWorker } from "./worker-loader.ts";

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
  } as unknown as Parameters<typeof loadConfinedWorker>[0]["env"];
  return { env, keys, warm };
};

test("two DIFFERENT facet identities never share one Worker Loader cacheKey", async () => {
  // context "/x:y" + class "Door" vs context "/x" + class "y:Door": a naive `${context}:${class}`
  // owner composes the IDENTICAL "prj_u.iterate/x:y:Door" — the second caller would reuse the
  // first's isolate, a silent cross-context authority transfer. Same shared source (identical
  // contentHash), as in prod.
  const { env, keys } = fakeLoaderEnv();
  const modules = { "cap.js": "export default class Door {}" };
  const load = (iterateContextName: string, className: string) =>
    loadConfinedWorker({
      env,
      deployId: "deploy-1",
      itxEntrypoint: {} as Fetcher,
      kind: "facet",
      owner: facetLoaderOwner(iterateContextName, className),
      source: modules,
      invoke: () => Promise.reject(new Error("literal modules — nothing to invoke")),
      where: `facet "${className}"`,
    });
  await load(DurableObjectNameCodec.stringify({ projectId: "prj_u", path: "/x:y" }), "Door");
  await load(DurableObjectNameCodec.stringify({ projectId: "prj_u", path: "/x" }), "y:Door");
  expect(keys).toHaveLength(2);
  expect(new Set(keys).size).toBe(2); // distinct — the length-prefix makes the split unambiguous
});

test("a producer source runs INSIDE getCode — once per cold isolate, never on a warm key — and needs a cacheKey", async () => {
  const { env, keys } = fakeLoaderEnv();
  let produced = 0;
  const invoke = async () => {
    produced++;
    return { "cap.js": "export default class Built {}" };
  };
  const load = (cacheKey?: string) =>
    loadConfinedWorker({
      env,
      deployId: "deploy-1",
      itxEntrypoint: {} as Fetcher,
      kind: "worker",
      owner: "prj_u.iterate/",
      source: "itx.build('todo')",
      cacheKey,
      invoke,
      where: "workers.get",
    });
  // refused without a key: hashing the expression would be the stale-code trap
  await expect(load()).rejects.toThrow(/needs a cacheKey/);
  expect(produced).toBe(0);
  // with a key: the producer runs when the key is cold …
  const first = await load("todo@3f2a1c");
  expect(first.loaderId).toBe("worker:deploy-1:prj_u.iterate/:todo@3f2a1c");
  expect(keys.at(-1)).toBe(first.loaderId);
  await Promise.resolve(); // let getCode's async body run
  expect(produced).toBe(1);
  // … and NOT when it is warm — "same key ⇒ same code" is the caller's contract
  await load("todo@3f2a1c");
  await Promise.resolve();
  expect(produced).toBe(1);
  // a new key is a new isolate: the producer runs again
  await load("todo@4b7d");
  await Promise.resolve();
  expect(produced).toBe(2);
});

test("literal modules: the key is their content hash unless the caller names a cacheKey", async () => {
  const { env, keys } = fakeLoaderEnv();
  const base = {
    env,
    deployId: "deploy-1",
    itxEntrypoint: {} as Fetcher,
    kind: "worker" as const,
    owner: "prj_u.iterate/",
    invoke: () => Promise.reject(new Error("literal modules — nothing to invoke")),
    where: "workers.get",
  };
  const a = await loadConfinedWorker({ ...base, source: { "cap.js": "export default 1" } });
  const b = await loadConfinedWorker({ ...base, source: { "cap.js": "export default 2" } });
  expect(a.loaderId).not.toBe(b.loaderId); // content decides
  const named = await loadConfinedWorker({
    ...base,
    source: { "cap.js": "export default 1" },
    cacheKey: "v7",
  });
  expect(named.loaderId).toBe("worker:deploy-1:prj_u.iterate/:v7");
  expect(keys.at(-1)).toBe(named.loaderId);
  await expect(
    loadConfinedWorker({ ...base, source: { "index.js": "export default 1" } }),
  ).rejects.toThrow(/"cap.js" main module/);
});

test("WORKAROUND: a producer that threw marks its id dead; the next attempt produces OUTSIDE the loader and loads literally under the id's next generation; a producer that keeps failing mints nothing", async () => {
  const { env, keys, warm } = fakeLoaderEnv();
  let artifactLanded = false;
  let produced = 0;
  const invoke = async () => {
    produced++;
    if (!artifactLanded) throw new Error("build artifact not landed yet");
    return { "cap.js": "export default class Built {}" };
  };
  const load = () =>
    loadConfinedWorker({
      env,
      deployId: "deploy-1",
      itxEntrypoint: {} as Fetcher,
      kind: "worker",
      owner: "prj_u.iterate/",
      source: "itx.build('todo')",
      cacheKey: "todo@dead",
      invoke,
      where: "workers.get",
    });
  // 1. the producer throws INSIDE getCode — workerd keeps that rejection under the id forever
  const first = await load();
  expect(first.loaderId).toBe("worker:deploy-1:prj_u.iterate/:todo@dead");
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
  expect(recovered.loaderId).toBe("worker:deploy-1:prj_u.iterate/:todo@dead#1");
  await expect(warm.get(recovered.loaderId)).resolves.toMatchObject({
    modules: { "cap.js": "export default class Built {}" },
  });
  expect(produced).toBe(4);
  // 4. …and from here the generation is warm: no producer run, no new id
  await load();
  expect(produced).toBe(4);
  expect(new Set(keys).size).toBe(2); // the dead id and its one recovered generation
});
