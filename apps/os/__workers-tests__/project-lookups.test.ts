// How long an isolate keeps what it asked the control plane's D1 (src/control-plane/edge.ts `Kept`):
// a project's row (its primary hostname with it) and a host's address five seconds, a label no
// project holds never. A project's context keeps its own slug in its storage
// (src/iterate-context-durable-object.ts `#projectSlug`).
import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { expect, onTestFinished, test, vi } from "vitest";
import { adminSession, catalog, interceptCatalogReads, stub } from "./support.ts";

test("a project created through this isolate's edge right after its label was missed is served at once", async () => {
  const label = freshLabel("created-here");
  await expectNoProject(label);

  using _project = await (await operator()).projects.create({ project: label });
  const served = await call(`https://${label}.projects.test/`);
  expect(served, await served.clone().text()).not.toMatchObject({ status: 421 });
});

test("a project created elsewhere right after its label was missed is served here at once", async () => {
  const label = freshLabel("created-elsewhere");
  await expectNoProject(label);

  // straight on the catalog, as another isolate's edge would
  await catalog().createProject({ principal: { actor: "admin" } }, { project: label }, Date.now());
  // admitted: the project's own context answers (it has no site yet)
  const served = await call(`https://${label}.projects.test/`);
  expect(served, await served.clone().text()).toMatchObject({ status: 404 });
  expect(await served.text()).toMatch(/has no site yet/);
});

test("a project deleted on another isolate is refused here once five seconds have passed", async () => {
  const clock = standingClock();
  const label = freshLabel("deleted-elsewhere");
  await catalog().createProject({ principal: { actor: "admin" } }, { project: label }, Date.now());
  // served, so this isolate keeps the row: its context answers (it has no site yet)
  expect(await call(`https://${label}.projects.test/`)).toMatchObject({ status: 404 });

  // straight on the catalog, as another isolate's edge would: within the five seconds this
  // isolate keeps the row it still admits the host, the window a deletion elsewhere goes unseen.
  // This 404 is the deleted project's root context, its storage born again empty: the assertion
  // pins that rebirth, and changes when a deleted project's storage can no longer be recreated.
  await catalog().deleteProject({ principal: { actor: "admin" } }, label);
  expect(await call(`https://${label}.projects.test/`)).toMatchObject({ status: 404 });
  clock.pass(6_000);
  await expectNoProject(label);
});

test("a primary hostname cleared on another isolate stops redirecting here once five seconds have passed", async () => {
  const clock = standingClock();
  const label = freshLabel("cleared-primary");
  const project = await catalog().createProject(
    { principal: { actor: "admin" } },
    { project: label },
    Date.now(),
  );
  const primary = `www.${label}.test`;
  await catalog().claimHostname(project.id, primary);
  await catalog().setPrimaryHostname(project.id, primary);
  const navigate = { headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } };
  const redirected = await call(`https://echo--${label}.projects.test/a?b=1`, navigate);
  expect(redirected).toMatchObject({ status: 308 });
  expect(redirected.headers.get("location")).toBe(`https://echo.${primary}/a?b=1`);

  // straight on the catalog, as the project's processor on another isolate would: within the five
  // seconds this isolate keeps the row, its navigations still go to the primary
  await catalog().setPrimaryHostname(project.id, null);
  expect(await call(`https://${label}.projects.test/`, navigate)).toMatchObject({ status: 308 });
  clock.pass(6_000);
  // served: the project's own context answers (it has no site yet)
  const served = await call(`https://${label}.projects.test/`, navigate);
  expect(served, await served.clone().text()).toMatchObject({ status: 404 });
  expect(await served.text()).toMatch(/has no site yet/);
});

test("a made-up hostname's miss is kept five seconds, then read again", async () => {
  const clock = standingClock();
  const hostname = `${freshLabel("made-up")}.nowhere.test`;
  const reads = interceptCatalogReads().projectByHostname;
  const asked = () => reads.mock.calls.filter(([first]) => first === hostname);
  await call(`https://${hostname}/.env`);
  await call(`https://${hostname}/.git/config`);
  expect(asked()).toHaveLength(1);

  clock.pass(6_000);
  await call(`https://${hostname}/.env`);
  expect(asked()).toHaveLength(2);
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

function call(url: string, init?: RequestInit) {
  return exports.default.fetch(new Request(url, { redirect: "manual", ...init }));
}

async function expectNoProject(label: string) {
  const answer = await call(`https://${label}.projects.test/`);
  expect(answer).toMatchObject({ status: 421 });
  expect(await answer.text()).toBe(`421: no project ${JSON.stringify(label)} is served here\n`);
}

/** `Date` standing still, here and in the worker under test (this isolate's), until `pass` moves
 *  it — so a row's "within five seconds" is no race with CI's load; real again when the test
 *  finishes. */
function standingClock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => void vi.useRealTimers());
  return { pass: (ms: number) => vi.setSystemTime(Date.now() + ms) };
}

/** An operator's /api session, disposed when the test finishes. */
function operator() {
  const sessions: Disposable[] = [];
  onTestFinished(() => {
    for (const session of sessions) session[Symbol.dispose]();
  });
  return adminSession(sessions);
}
