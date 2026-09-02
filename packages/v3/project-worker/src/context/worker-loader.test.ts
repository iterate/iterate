// context/worker-loader.test.ts — the Worker Loader cacheKey is an AUTHORITY boundary: the
// isolate's whole world (its env.ITX host stub, its globalOutbound) is baked in at first
// materialization, so two callers who compose the same key SHARE an isolate. loadConfinedWorker
// mints `${kind}:${deploy}:${owner}:${sourceVersion}` (the caller's cacheKey, else the modules'
// content hash); a facet's owner is (context name, class name), and either half may contain ":" (a
// context path is any string; ES2022 allows `export { X as "y:Door" }`). `facetLoaderOwner`
// length-prefixes the context so the split is unambiguous whatever either half contains. The second
// half pins Cloudflare's `get(id, getCode)` contract as we use it: a PRODUCER expression runs inside
// `getCode` (a cold isolate only) and is refused without a cacheKey.
import { expect, test } from "vitest";
import { DurableObjectNameCodec } from "./durable-object-names.ts";
import { facetLoaderOwner, loadConfinedWorker } from "./worker-loader.ts";

/** A fake `env.LOADER` that records every key and — like Cloudflare — runs `getCode` once per NEW key. */
const fakeLoaderEnv = () => {
  const keys: string[] = [];
  const warm = new Map<string, unknown>();
  const env = {
    LOADER: {
      get: (key: string, getCode: () => unknown) => {
        keys.push(key);
        if (!warm.has(key)) warm.set(key, getCode());
        return {};
      },
    },
    CF_VERSION_METADATA: { id: "deploy-1" },
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
      host: {} as Fetcher,
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
      host: {} as Fetcher,
      kind: "code",
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
  expect(first.sourceVersion).toBe("todo@3f2a1c");
  expect(keys.at(-1)).toBe("code:deploy-1:prj_u.iterate/:todo@3f2a1c");
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
    host: {} as Fetcher,
    kind: "code" as const,
    owner: "prj_u.iterate/",
    invoke: () => Promise.reject(new Error("literal modules — nothing to invoke")),
    where: "workers.get",
  };
  const a = await loadConfinedWorker({ ...base, source: { "cap.js": "export default 1" } });
  const b = await loadConfinedWorker({ ...base, source: { "cap.js": "export default 2" } });
  expect(a.sourceVersion).not.toBe(b.sourceVersion); // content decides
  const named = await loadConfinedWorker({
    ...base,
    source: { "cap.js": "export default 1" },
    cacheKey: "v7",
  });
  expect(named.sourceVersion).toBe("v7");
  expect(keys.at(-1)).toBe("code:deploy-1:prj_u.iterate/:v7");
  await expect(
    loadConfinedWorker({ ...base, source: { "index.js": "export default 1" } }),
  ).rejects.toThrow(/"cap.js" main module/);
});
