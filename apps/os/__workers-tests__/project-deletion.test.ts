// Deleting a project (session.ts `projects.delete`, project/processor.ts THE DELETION SAGA): the
// control plane drops its row at once, and the saga on its root destroys every context the project's
// registry names (each announced itself: `itx/child-created`), its kv, and the root last. A context
// read afterwards is born again from nothing: its old log, a marker written before, is gone.
import { expect, test } from "vitest";
import { env } from "cloudflare:workers";
import type { StreamEvent } from "iterate/stream/processor";
import { CONTEXT_DESTROYED } from "../src/context/paths.ts";
import { adminCredentials, controlPlane, openSession, readLog, refused, until } from "./support.ts";

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

  // the root goes last: once it is born again empty, every context below it is gone too
  // a read that lands while the root is being destroyed is rejected by its reset: not yet
  await until(
    "the root is destroyed",
    async () =>
      !(
        await readLog(`${projectId}.iterate/`).catch((error: unknown) => {
          if (!String(error).includes(CONTEXT_DESTROYED)) throw error;
          return [{ type: "events.iterate.com/project/create-requested" } as StreamEvent];
        })
      ).some((event) => event.type === "events.iterate.com/project/create-requested"),
    30_000,
  );
  for (const path of ["/", ...paths])
    expect(
      (await readLog(`${projectId}.iterate${path}`)).filter(
        (event) => event.type === "test/marker",
      ),
      path,
    ).toEqual([]);
  expect(await env.ITX_KV.list({ prefix: `${projectId}:` })).toMatchObject({ keys: [] });
});
