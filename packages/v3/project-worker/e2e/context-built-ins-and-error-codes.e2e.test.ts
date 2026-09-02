// context-built-ins-and-error-codes.e2e.test.ts — the context's BUILT-IN roots (prefixed kv, cd) and
// the error grammar across the /api hop. A ctx id is [A-Za-z0-9_-] (a ':' can never be spelled, so
// the kv/secret prefix wall holds); `kv.list` returns EVERY key, not the first KV page; `cd('x')` and
// `cd('/x')` are the SAME sibling stream and `cd('')` is SELF; a default-deny miss and a paused-stream
// refusal each carry their machine-readable `code` end to end (lib/errors.ts: classify by code,
// never by message — own props survive DO → relay → client).

import { expect, test } from "vitest";
import { append, codeOf, freshCtx, openItx, rejection } from "./support/client.ts";

test("a legitimate ctx (hyphen, underscore, uppercase, digits) is served; a ':' in the ctx is REJECTED (the kv/secret isolation wall holds)", async () => {
  // DurableObjectNameCodec.parse gates the projectId to [A-Za-z0-9_-] — the ONE place every DO name
  // is parsed, so a ":"-nested project (whose prefixed kv key would alias another project's) can
  // never be materialized at all; the prefix IS the whole isolation wall.
  const legit = freshCtx("FixReg-1_A"); // hyphen, underscore, uppercase, digits
  const good = openItx(legit);
  await good.provide("itx.probe", "itx.whoami"); // a probe → whoami round trip proves the ctx addressed the right project
  expect(await good.invokeCapability(["itx", ["probe"]])).toMatchObject({ projectId: legit });

  const a = openItx(freshCtx("w2kv"));
  expect(await a.kv.put("x:leak", "A-private")).toMatchObject({ ok: true });
  // "<ctx>:x" cannot exist: the DO refuses the invalid name at parse, so the session never
  // materializes (surfaces as a failed connection) — the leak is unspellable. (Wrapped in a native
  // promise — capnweb proxy rejections probe vacuously otherwise.)
  await expect(
    (async () => {
      await openItx(`${freshCtx("w2kv")}:x`).kv.get("leak"); // never reached
    })(),
  ).rejects.toThrow();
});

test("kv list returns EVERY key, not silently the first 1000", async () => {
  // Cloudflare KV caps a list page at 1000 keys; `kv.list()` paginates on the cursor until
  // `list_complete`, so key 1001+ is never a permanent orphan for a sweep/GC/inventory caller.
  const itx = openItx(freshCtx("kvlist"));
  const total = 1001;
  const names = Array.from({ length: total }, (_, i) => `k${String(i).padStart(4, "0")}`);
  for (let i = 0; i < names.length; i += 100) {
    await Promise.all(names.slice(i, i + 100).map((n) => itx.kv.put(n, "1")));
  }
  const listed = await itx.invokeCapability(["itx", "kv", ["list"]]);
  expect(listed.keys).toHaveLength(total);
}, 60_000);

test("cd('x') and cd('/x') are the SAME sibling stream", async () => {
  // Pins the one-DO-per-logical-context rule: the codec's normalizePath runs on every sibling
  // resolution, so the slash-less spelling cannot mint a shadow twin of the same context.
  const itx = openItx(freshCtx("cd"));
  await itx.invokeCapability("itx.cd('x').append({type:'ping-x'})");
  const page = await itx.invokeCapability("itx.cd('/x').read(0, 50)");
  expect(page.events.map((e: any) => e.type)).toContain("ping-x");
});

test("cd('') resolves to THIS context (self) and answers rather than wedging", async () => {
  // The root's own path is "/" but cd('') normalizes to "/" AFTER the own-path fast-path check, so
  // the empty spelling reaches SELF through a Workers-RPC self-stub instead of the in-process
  // closure. Pin: the self-call answers (workerd delivers self-RPC re-entrantly) and lands in the
  // SAME log — if this ever deadlocks or splits the log, the fast-path comparison must normalize
  // BEFORE comparing.
  const itx = openItx(freshCtx("self"));
  const raced = await Promise.race([
    itx.invokeCapability("itx.cd('').append({type:'self-ping'})"),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("self-context call wedged >10s (self-RPC deadlock)")),
        10_000,
      ),
    ),
  ]);
  expect((raced as any[])[0].type).toBe("self-ping");
  const page = await itx.invokeCapability(["itx", ["read", 0, 50]]);
  expect(page.events.map((e: any) => e.type)).toContain("self-ping");
});

test("a default-deny miss carries code NO_CAPABILITY_MATCH across the /api hop", async () => {
  const itx = openItx(freshCtx("codemiss"));
  const err = await rejection(itx.invokeCapability(["itx", "nope", ["thing"]]));
  expect(codeOf(err)).toBe("NO_CAPABILITY_MATCH");
  expect(err.message).toMatch(/no capability matches/);
});

test("a paused-stream refusal carries code STREAM_PAUSED across the /api hop", async () => {
  // enforcement refusals ride the same coded channel end to end
  const itx = openItx(freshCtx("codepause"));
  await append(itx, { type: "events.iterate.com/stream/paused", payload: { reason: "operator" } });
  const err = await rejection(append(itx, { type: "mark", payload: { n: 1 } }));
  expect(codeOf(err)).toBe("STREAM_PAUSED");
  expect(err.message).toContain("stream paused");
});
