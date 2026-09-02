// context/worker-loader.test.ts — the Worker Loader cacheKey is an AUTHORITY boundary: the
// isolate's whole world (its env.ITX host stub, its globalOutbound) is baked in at first
// materialization, so two callers who compose the same key SHARE an isolate. confinedWorker mints
// `${kind}:${deploy}:${owner}:${contentHash}`; a facet's owner is (context name, class name), and
// either half may contain ":" (a context path is any string; ES2022 allows
// `export { X as "y:Door" }`). `facetLoaderOwner` length-prefixes the context so the split is
// unambiguous whatever either half contains.
import { expect, test } from "vitest";
import { DurableObjectNameCodec } from "./durable-object-names.ts";
import { confinedWorker, facetLoaderOwner } from "./worker-loader.ts";

test("two DIFFERENT facet identities never share one Worker Loader cacheKey", () => {
  // context "/x:y" + class "Door" vs context "/x" + class "y:Door": a naive `${context}:${class}`
  // owner composes the IDENTICAL "prj_u.iterate/x:y:Door" — the second caller would reuse the
  // first's isolate, a silent cross-context authority transfer. Same shared source (identical
  // contentHash), as in prod.
  const keys: string[] = [];
  const env = {
    LOADER: {
      get: (key: string) => {
        keys.push(key);
        return {};
      },
    },
    CF_VERSION_METADATA: { id: "deploy-1" },
  } as unknown as Parameters<typeof confinedWorker>[0];
  const host = {} as Parameters<typeof confinedWorker>[4];
  const modules = { "cap.js": "export default class Door {}" };
  const contentHash = "1abc2d";

  const contextA = DurableObjectNameCodec.stringify({ projectId: "prj_u", path: "/x:y" });
  confinedWorker(
    env,
    { kind: "facet", owner: facetLoaderOwner(contextA, "Door"), contentHash },
    "cap.js",
    modules,
    host,
  );
  const contextB = DurableObjectNameCodec.stringify({ projectId: "prj_u", path: "/x" });
  confinedWorker(
    env,
    { kind: "facet", owner: facetLoaderOwner(contextB, "y:Door"), contentHash },
    "cap.js",
    modules,
    host,
  );
  expect(keys).toHaveLength(2);
  expect(new Set(keys).size).toBe(2); // distinct — the length-prefix makes the split unambiguous
});
