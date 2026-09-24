// Every wake of a context tells each ancestor up to its owner's root (src/context/paths.ts
// `ancestorPathsOf`) that it exists: `context/child-created { childPath }`, keyed by the child, so
// the project root's log names every context below it and a repeat lands nothing new.
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import type { StreamEvent } from "iterate/stream/processor";
import type { IterateContextDurableObject } from "../src/iterate-context-durable-object.ts";
import { stub, until } from "./support.ts";

test("a context born at /a/b/c is announced to /, /a and /a/b — each ancestor it woke announces itself too — and a later wake announces nothing new", async () => {
  const project = `prj_announce_${crypto.randomUUID().slice(0, 8)}`;
  await stub(`${project}.iterate/a/b/c`).read(0, 1);
  await until("the root names all three", async () => {
    const paths = await childPathsIn(project);
    return ["/a", "/a/b", "/a/b/c"].every((path) => paths.includes(path));
  });
  expect((await childPathsIn(project)).sort()).toEqual(["/a", "/a/b", "/a/b/c"]);
  expect((await childPathsIn(`${project}.iterate/a`)).sort()).toEqual(["/a/b", "/a/b/c"]);
  expect(await childPathsIn(`${project}.iterate/a/b`)).toEqual(["/a/b/c"]);
  // a new incarnation announces again; the keys make it land nothing
  await evictDurableObject(stub(`${project}.iterate/a/b/c`));
  await stub(`${project}.iterate/a/b/c`).read(0, 1);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect((await childPathsIn(project)).sort()).toEqual(["/a", "/a/b", "/a/b/c"]);
});

test("a paused ancestor still records a descendant's announcement", async () => {
  const project = `prj_announce_${crypto.randomUUID().slice(0, 8)}`;
  await stub(project).append({
    type: "events.iterate.com/stream/paused",
    payload: { reason: "test" },
  });
  await stub(`${project}.iterate/paused-child`).read(0, 1);
  await until("the paused root names it", async () =>
    (await childPathsIn(project)).includes("/paused-child"),
  );
});

test("a user's contexts announce up to the user's root and no further: the kernel's global contexts hear nothing", async () => {
  const user = `u_${crypto.randomUUID().slice(0, 8)}`;
  await stub(`global.iterate/users/${user}/notes/today`).read(0, 1);
  await until("the user's root names both", async () => {
    const paths = await childPathsIn(`global.iterate/users/${user}`);
    return [`/users/${user}/notes`, `/users/${user}/notes/today`].every((path) =>
      paths.includes(path),
    );
  });
  expect(
    (await childPathsIn("global.iterate/users")).filter((path) => path.includes(user)),
  ).toEqual([]);
});

/** The descendants a context's log names, in the order they announced themselves. */
async function childPathsIn(ctx: string): Promise<string[]> {
  const events = await runInDurableObject(
    stub(ctx),
    async (instance: IterateContextDurableObject) => (await instance.read(0, 500)).events,
  );
  return events
    .filter((event: StreamEvent) => event.type === "events.iterate.com/context/child-created")
    .map((event: StreamEvent) => (event.payload as { childPath: string }).childPath);
}
