// How often a project's row is asked of the control plane's D1. A project host's admission
// (src/control-plane/edge.ts `getProjectKeepingMisses`) keeps a label no project holds five seconds
// per isolate, so a scanner's burst at one unknown label is one read, and a project created right
// after its label was missed is still served promptly. A project's context keeps its own slug in
// its storage (src/iterate-context-durable-object.ts `#projectSlug`).
import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { expect, onTestFinished, test, vi } from "vitest";
import { adminSession, catalog, interceptCatalogReads, stub, until } from "./support.ts";

test("a burst at a label no project holds is one control-plane read: the miss is kept five seconds, then read again", async () => {
  const label = freshLabel("unknown");
  const reads = interceptCatalogReads().project;

  await expectNoProject(label);
  const burst = await Promise.all(
    Array.from({ length: 20 }, (_, index) => call(`https://${label}.projects.test/.env.${index}`)),
  );
  expect(burst.map((answer) => answer.status)).toEqual(Array(20).fill(421));
  expect(reads.mock.calls.filter(([ref]) => ref === label)).toHaveLength(1);

  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => void vi.useRealTimers());
  vi.setSystemTime(Date.now() + 6_000);
  await expectNoProject(label);
  expect(reads.mock.calls.filter(([ref]) => ref === label)).toHaveLength(2);
});

test("a project created through this isolate's edge right after its label was missed is served at once", async () => {
  const label = freshLabel("created-here");
  await expectNoProject(label);

  using _project = await (await operator()).projects.create({ project: label });
  const served = await call(`https://${label}.projects.test/`);
  expect(served, await served.clone().text()).not.toMatchObject({ status: 421 });
});

test("a read that missed a label while this isolate created its project keeps no miss: the next request is served", async () => {
  const label = freshLabel("created-mid-read");
  let held = false;
  let missedRead = false;
  let answering = false;
  // the first read runs now, and misses; its answer reaches the edge only once the row lets it.
  // Each side polls a flag on its own timer: a promise one request resolves for another does not
  // wake it
  interceptCatalogReads({
    reads: ["project"],
    with: <T>(read: () => Promise<T>) => {
      if (held) return read();
      held = true;
      return read().then(
        (missing) =>
          new Promise<T>((resolve) => {
            missedRead = true;
            const wait = () => (answering ? resolve(missing) : setTimeout(wait, 20));
            wait();
          }),
      );
    },
  });

  const missed = call(`https://${label}.projects.test/`);
  await until("the first read missed", () => missedRead);
  using _project = await (await operator()).projects.create({ project: label });
  answering = true;
  expect(await missed).toMatchObject({ status: 421 });

  const served = await call(`https://${label}.projects.test/`);
  expect(served, await served.clone().text()).not.toMatchObject({ status: 421 });
});

test("a project created elsewhere right after its label was missed is served here within five seconds", async () => {
  const label = freshLabel("created-elsewhere");
  await expectNoProject(label);

  // straight on the catalog, as another isolate's edge would: this isolate's miss stands
  await catalog().createProject({ principal: { actor: "admin" } }, { project: label });
  await expectNoProject(label);

  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => void vi.useRealTimers());
  vi.setSystemTime(Date.now() + 6_000);
  // admitted: the project's own context answers (it has no site yet)
  const served = await call(`https://${label}.projects.test/`);
  expect(served, await served.clone().text()).toMatchObject({ status: 404 });
  expect(await served.text()).toMatch(/has no site yet/);
});

test("a project's context reads its slug from the control plane once and keeps it: what its storage holds is what it answers", async () => {
  const slug = freshLabel("own-slug");
  using project = await (await operator()).projects.create({ project: slug });
  const { projectId, projectSlug } = await project.whoami();
  expect(projectSlug).toBe(slug);
  expect(
    await runInDurableObject(stub(projectId), (_instance, state) =>
      state.storage.kv.get("project-slug"),
    ),
  ).toBe(slug);

  await runInDurableObject(stub(projectId), (_instance, state) =>
    state.storage.kv.put("project-slug", "kept-slug"),
  );
  expect(await project.whoami()).toMatchObject({ projectId, projectSlug: "kept-slug" });
});

const freshLabel = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

function call(url: string) {
  return exports.default.fetch(new Request(url, { redirect: "manual" }));
}

async function expectNoProject(label: string) {
  const answer = await call(`https://${label}.projects.test/`);
  expect(answer).toMatchObject({ status: 421 });
  expect(await answer.text()).toBe(`421: no project ${JSON.stringify(label)} is served here\n`);
}

/** An operator's /api session, disposed when the test finishes. */
function operator() {
  const sessions: Disposable[] = [];
  onTestFinished(() => {
    for (const session of sessions) session[Symbol.dispose]();
  });
  return adminSession(sessions);
}
