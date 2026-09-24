// __workers-tests__/kv-list-pagination.test.ts — `itx.kv.list()` returns EVERY key under its prefix,
// not the first page. KV answers at most 1000 keys per list call, and the built-in
// (src/context/built-ins.ts `kv.list`) follows the cursor until `list_complete`, so key 1001+ is never
// a permanent orphan for a sweep, GC or inventory caller.
//
// Pinned inside workerd, not against a deployed worker: miniflare's KV pages the same way (1000 keys,
// then a cursor) and a list reads what was just written. Deployed KV's list is eventually consistent,
// up to about 60 s after a write (Cloudflare's KV docs), so the deployed row this replaces measured
// KV propagation, not the pagination — it timed out waiting 15 s for 1001 keys in 9 of 124 preview
// e2e runs (the CI flake dashboard, issue #2580).
import { expect, test } from "vitest";
import { stub } from "./support.ts";

test("kv.list follows the cursor past the 1000-key page: 1001 keys come back as 1001, in key order, and the prefix still narrows", async () => {
  const itx = stub("prj_kv_list_pagination");
  const names = Array.from({ length: 1001 }, (_, i) => `k${String(i).padStart(4, "0")}`);
  for (let i = 0; i < names.length; i += 100)
    await Promise.all(
      names.slice(i, i + 100).map((name) => itx.invoke(["itx", "kv", ["put", name, "1"]])),
    );
  await itx.invoke(["itx", "kv", ["put", "other", "1"]]);
  expect(await itx.invoke(["itx", "kv", ["list", "k"]])).toEqual({ keys: names });
  expect(await itx.invoke(["itx", "kv", ["list"]])).toEqual({ keys: [...names, "other"] });
});
