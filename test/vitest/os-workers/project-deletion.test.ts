// Deleting a project (session.ts `projects.delete`, project/processor.ts THE DELETION SAGA): the
// control plane drops its row at once, and the saga on its root destroys every context the project's
// registry names (each announced itself: `itx/child-created`), its kv, and the root last. A context
// below the root read afterwards is born again from nothing: its old log, a marker written before,
// is gone. The root is never born again (iterate-context-durable-object.ts
// `#refuseBirthOfDeletedProjectRoot`): whatever reaches it is refused.
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { env } from "cloudflare:workers";
import { errorCode } from "iterate/lib";
import { CONTEXT_DESTROYED } from "../../../apps/os/src/context/paths.ts";
import {
  adminCredentials,
  controlPlane,
  openSession,
  readLog,
  refused,
  rule,
  stub,
  until,
} from "./support.ts";

test("deleting a project drops its row at once, then destroys every context it announced, its kv, and its root last", async () => {
  const admin = (await openSession()).authenticate(adminCredentials());
  const slug = `deleted-${crypto.randomUUID().slice(0, 8)}`;
  const itx = await admin.projects.create({ project: slug });
  const { projectId } = (await itx.whoami()) as { projectId: string };
  const paths = ["/agents", "/agents/a", "/notes", "/notes/today"];
  for (const path of ["/", ...paths])
    await itx.cd(path).append({ type: "test/marker", payload: { path } });
  await itx.kv.put("left-behind", "yes");
  await until("the root names every context below it", async () => {
    const announced = (await readLog(`${projectId}.iterate/`))
      .filter((event) => event.type === "events.iterate.com/itx/child-created")
      .map((event) => (event.payload as { childPath: string }).childPath);
    return paths.every((path) => announced.includes(path));
  });

  await admin.projects.delete(slug);
  // the door: the row is gone the moment the verb answers
  expect(await controlPlane().getProject(projectId)).toBeNull();
  await refused(() => admin.projects.delete(slug), "FORBIDDEN");

  // the root goes last: once it refuses a read, every context below it is gone too
  expect(errorCode(await rootOnceDestroyed(projectId))).toBe("FORBIDDEN");
  for (const path of paths)
    expect(
      (await readLog(`${projectId}.iterate${path}`)).filter(
        (event) => event.type === "test/marker",
      ),
      path,
    ).toEqual([]);
  expect(await env.ITX_KV.list({ prefix: `${projectId}:` })).toMatchObject({ keys: [] });
});

// iterate-context-durable-object.ts `#refuseBirthOfDeletedProjectRoot` and `#unbornStill`.
test("a deleted project's root is never born again: whatever reaches it is refused, and nothing is stored, until the project is restored", async () => {
  const admin = (await openSession()).authenticate(adminCredentials());
  const slug = `reborn-${crypto.randomUUID().slice(0, 8)}`;
  const itx = await admin.projects.create({ project: slug });
  const { projectId } = (await itx.whoami()) as { projectId: string };
  await admin.projects.delete(slug);

  const reached = await rootOnceDestroyed(projectId);
  expect(
    reached,
    "a request that reaches a deleted project's root should be refused",
  ).toBeInstanceOf(Error);
  expect(reached).toMatchObject({
    code: "FORBIDDEN",
    message: expect.stringMatching(/was deleted/),
  });
  await refused(
    async () => (await admin.projects.get(projectId)).readEvents(0, 1),
    "FORBIDDEN",
    /was deleted/,
  );
  expect(
    await runInDurableObject(stub(`${projectId}.iterate/`), (_instance, state) =>
      state.storage.sql.exec("SELECT name FROM sqlite_master").toArray(),
    ),
    "the root should hold no storage",
  ).toEqual([]);

  // a seed restores the project under its id: the refused root resets on the next call, which
  // fails, and the call after it bears the root
  await expect(
    admin.projects.create({ project: slug, restoreProjectId: projectId }),
  ).rejects.toThrow(/was restored: its root is born on the next request/);
  const restored = await admin.projects.create({ project: slug, restoreProjectId: projectId });
  expect(await restored.whoami()).toMatchObject({ projectId });
  expect((await readLog(`${projectId}.iterate/`)).map((event) => event.type)).toContain(
    "events.iterate.com/project/create-requested",
  );
});

test("a project root's own mask at `itx.processors` does not stop its deletion: the platform enables the deletion's processor at the fixed point", async () => {
  const admin = (await openSession()).authenticate(adminCredentials());
  const slug = `masked-${crypto.randomUUID().slice(0, 8)}`;
  const itx = await admin.projects.create({ project: slug });
  const { projectId } = (await itx.whoami()) as { projectId: string };
  await itx.append(rule("itx.processors", null));
  await refused(() => itx.processors.enable("project"), "NO_ITX_EXPRESSION_MATCH");

  await admin.projects.delete(slug);
  expect(await controlPlane().getProject(projectId)).toBeNull();
  expect(errorCode(await rootOnceDestroyed(projectId))).toBe("FORBIDDEN");
});

// The verb asks for the deletion before it drops the row, so the saga can reach the root while the
// row stands: it destroys the root only once the row is gone (project/durable-object.ts), its pass
// run again 5 s later (processor.ts).
test("the saga destroys a project's root only once its row is gone", async () => {
  const admin = (await openSession()).authenticate(adminCredentials());
  const slug = `row-first-${crypto.randomUUID().slice(0, 8)}`;
  const itx = await admin.projects.create({ project: slug });
  const { projectId } = (await itx.whoami()) as { projectId: string };
  const root = `${projectId}.iterate/`;
  // the verb's first half alone: the deletion asked for as the platform, the row still standing
  await stub(root).invoke(
    [
      "itx",
      "builtins",
      [
        "append",
        {
          type: "events.iterate.com/project/delete-requested",
          idempotencyKey: "project/delete-requested",
          payload: {},
        },
      ],
    ],
    [],
    { principal: { actor: "admin" }, platform: true },
  );
  // it first waits out the creation saga, as a deletion does
  await until(
    "the saga reaches the root",
    async () =>
      (await readLog(root)).some((event) => event.type === "events.iterate.com/project/deleted"),
    30_000,
  );
  // the root's destruction would follow at once: a second on, well inside the 5 s retry, it stands
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  expect(
    (await readLog(root)).some(
      (event) => event.type === "events.iterate.com/project/create-requested",
    ),
    "the root should stand while its row does",
  ).toBe(true);

  await admin.projects.delete(slug);
  expect(errorCode(await rootOnceDestroyed(projectId))).toBe("FORBIDDEN");
});

/** A read of the project's root once the saga destroyed it: what answered (the log, had it been born
 *  again, or the refusal). A read that lands while the root is being destroyed is rejected by its
 *  reset: not yet. */
const rootOnceDestroyed = (projectId: string) =>
  until(
    "the root is destroyed",
    () =>
      readLog(`${projectId}.iterate/`).then(
        (log) =>
          !log.some((event) => event.type === "events.iterate.com/project/create-requested") && log,
        (error: unknown) => !String(error).includes(CONTEXT_DESTROYED) && error,
      ),
    30_000,
  );
