// The context sweep's reach (session.ts `session.contexts`, scripts/ci/context-sweep.ts): a context
// reached by the id Cloudflare lists says who it is from its own birth record, without recording a
// wake; an id nothing was born at is refused and stays empty; and only an orphan — a context whose
// project the control plane does not hold — is destroyed.
import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createFailing } from "@iterate-com/shared/test-support/failing-test";
import { expect, test } from "vitest";
import { DurableObjectNameCodec } from "../src/context/paths.ts";
import { adminCredentials, catalog, openSession, readLog, refused, stub } from "./support.ts";

test("the sweep identifies a context by id without waking its ancestors, refuses an id nothing was born at, and destroys only an orphan", async () => {
  const admin = (await openSession()).authenticate(adminCredentials());
  const orphanProject = `prj_orphan${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await stub(`${orphanProject}.iterate/x`).append({ type: "test/marker", payload: {} });
  const orphan = idOf(orphanProject, "/x");
  const liveSlug = `swept-${crypto.randomUUID().slice(0, 8)}`;
  const live = await admin.projects.create({ project: liveSlug });
  const { projectId: liveProject } = (await live.whoami()) as { projectId: string };
  await live.cd("/y").readEvents(0, 1);
  const user = `u${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  await stub(`global.iterate/users/${user}`).read(0, 1);
  const never = idOf(orphanProject, "/never-born");

  // by id: who each is, and nothing recorded on the orphan (no wake, so no announcement)
  await evictDurableObject(stub(`${orphanProject}.iterate/x`));
  const before = (await readLog(`${orphanProject}.iterate/x`)).length;
  await evictDurableObject(stub(`${orphanProject}.iterate/x`));
  const identified = await admin.contexts.identify([
    orphan,
    idOf(liveProject, "/y"),
    idOf("global", `/users/${user}`),
    never,
  ]);
  expect(identified.slice(0, 3)).toEqual([
    { id: orphan, projectId: orphanProject, path: "/x" },
    { id: idOf(liveProject, "/y"), projectId: liveProject, path: "/y" },
    { id: idOf("global", `/users/${user}`), projectId: "global", path: `/users/${user}` },
  ]);
  expect(identified[3]).toMatchObject({
    id: never,
    error: expect.stringMatching(/addressed by name/),
  });
  // evicted again, so this read is a fresh incarnation recording one wake; had `identify` recorded
  // one in its own incarnation, the log would hold two more
  await evictDurableObject(stub(`${orphanProject}.iterate/x`));
  expect(await readLog(`${orphanProject}.iterate/x`)).toHaveLength(before + 1);

  // only the orphan is destroyed
  await refused(() => admin.contexts.destroy(idOf(liveProject, "/y")), "FORBIDDEN", /still exists/);
  await refused(
    () => admin.contexts.destroy(idOf("global", `/users/${user}`)),
    "FORBIDDEN",
    /global context/,
  );
  expect(await admin.contexts.destroy(orphan)).toEqual({ projectId: orphanProject, path: "/x" });
  // a stray born under a live project's SLUG, as if it were an id, is an orphan too
  await stub(`${liveSlug}.iterate/`).read(0, 1);
  expect(await admin.contexts.destroy(idOf(liveSlug, "/"))).toEqual({
    projectId: liveSlug,
    path: "/",
  });
  expect((await live.whoami()) as { projectId: string }).toMatchObject({ projectId: liveProject });
  expect(
    (await readLog(`${orphanProject}.iterate/x`)).filter((event) => event.type === "test/marker"),
  ).toEqual([]);
});

createFailing(test, /still exists: \/y is no orphan/)(
  "the sweep destroys a context of a project deleted on another isolate, on an isolate that read the project",
  async () => {
    const admin = (await openSession()).authenticate(adminCredentials());
    const { id: projectId } = await catalog().createProject(
      { principal: { actor: "admin" } },
      { project: `swept-late-${crypto.randomUUID().slice(0, 8)}` },
      Date.now(),
    );
    await stub(`${projectId}.iterate/y`).append({ type: "test/marker", payload: {} });
    // refused while the project stands: this isolate has read its row
    await refused(() => admin.contexts.destroy(idOf(projectId, "/y")), "FORBIDDEN", /still exists/);

    // straight on the catalog, as another isolate's edge would: this isolate still has the row
    await catalog().deleteProject({ principal: { actor: "admin" } }, projectId);
    expect(await admin.contexts.destroy(idOf(projectId, "/y"))).toEqual({ projectId, path: "/y" });
  },
);

const idOf = (projectId: string, path: string) =>
  env.ITERATE_CONTEXT.idFromName(DurableObjectNameCodec.stringify({ projectId, path })).toString();
