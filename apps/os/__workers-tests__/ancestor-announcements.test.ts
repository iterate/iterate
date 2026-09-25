// Every wake of a context tells each ancestor up to `/` (src/context/paths.ts `ancestorPathsOf`)
// that it exists: `itx/child-created { childPath }`, keyed by the child, so the root's log
// names every context below it and a repeat lands nothing new.
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import type { StreamEvent } from "iterate/stream/processor";
import type { IterateContextDurableObject } from "../src/iterate-context-durable-object.ts";
import { stub, until } from "./support.ts";

test("a context born at /a/b/c is announced to /, /a and /a/b — each ancestor it woke announces itself too — and it is sent once: remembered after it lands, deduped if sent again", async () => {
  const project = `prj_announce_${crypto.randomUUID().slice(0, 8)}`;
  await stub(`${project}.iterate/a/b/c`).read(0, 1);
  await until("the root names all three", async () => {
    const paths = await childPathsIn(project);
    return ["/a", "/a/b", "/a/b/c"].every((path) => paths.includes(path));
  });
  expect((await childPathsIn(project)).sort()).toEqual(["/a", "/a/b", "/a/b/c"]);
  expect((await childPathsIn(`${project}.iterate/a`)).sort()).toEqual(["/a/b", "/a/b/c"]);
  expect(await childPathsIn(`${project}.iterate/a/b`)).toEqual(["/a/b/c"]);
  // a landed announcement is remembered, so a later wake sends nothing; one sent again (the flag
  // lost) lands nothing, the keys dedupe it
  await until("the child remembers it announced", () =>
    runInDurableObject(stub(`${project}.iterate/a/b/c`), (_instance, state) =>
      state.storage.kv.get("ancestors-announced"),
    ),
  );
  await runInDurableObject(stub(`${project}.iterate/a/b/c`), (_instance, state) => {
    state.storage.kv.delete("ancestors-announced");
  });
  await evictDurableObject(stub(`${project}.iterate/a/b/c`));
  await stub(`${project}.iterate/a/b/c`).read(0, 1);
  await until("the re-announcement lands", () =>
    runInDurableObject(stub(`${project}.iterate/a/b/c`), (_instance, state) =>
      state.storage.kv.get("ancestors-announced"),
    ),
  );
  expect((await childPathsIn(project)).sort()).toEqual(["/a", "/a/b", "/a/b/c"]);
});

test("a paused ancestor still records a child's announcement", async () => {
  const project = `prj_announce_${crypto.randomUUID().slice(0, 8)}`;
  await stub(project).append({
    type: "events.iterate.com/itx/paused",
    payload: { reason: "test" },
  });
  await stub(`${project}.iterate/paused-child`).read(0, 1);
  await until("the paused root names it", async () =>
    (await childPathsIn(project)).includes("/paused-child"),
  );
});

/** The child contexts a context's log names, in the order they announced themselves. */
async function childPathsIn(ctx: string): Promise<string[]> {
  const events = await runInDurableObject(
    stub(ctx),
    async (instance: IterateContextDurableObject) => (await instance.read(0, 500)).events,
  );
  return events
    .filter((event: StreamEvent) => event.type === "events.iterate.com/itx/child-created")
    .map((event: StreamEvent) => (event.payload as { childPath: string }).childPath);
}
