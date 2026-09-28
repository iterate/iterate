// The Dash's context explorer (apps/dash/src/routes/_auth/projects/$slug/contexts.$.tsx): every
// context of a project, from the project's context registry, as a tree beside the context shown
// (packages/ui context-tree), each opening live in the general-purpose context view (packages/ui
// context-view), which appends events and reads a long log newest first.
import { expect } from "@playwright/test";
import { test } from "../test-support/test.ts";

test("a project's contexts are a tree from its registry, and one opens live and takes an appended event", async ({
  page,
  baseURL,
  helpers,
}) => {
  helpers.appOrigin("dash");
  await using fixture = await helpers.createFixture("contexts", { app: baseURL });
  // a context exists once it has woken: it announces itself to `/`, whose registry lists it
  await fixture.itx
    .cd("/demo/one")
    .append({ type: "manual/note-added", payload: { text: "seeded by the spec" } });
  await page.getByRole("link", { name: "Contexts", exact: true }).click();
  // each context in the tree is a link named by its whole path (it reads as its last segment)
  await page
    .getByRole("navigation", { name: "Contexts" })
    .getByRole("link", { name: "/demo/one", exact: true })
    .click();
  await page.getByText("seeded by the spec").waitFor();

  await page.getByRole("button", { name: "Append event", exact: true }).click();
  const draft = page.getByRole("textbox", { name: "Events to append" });
  await draft.fill("type: manual/note-added\npayload: { text: appended in the browser }\n");
  await page.getByRole("button", { name: "Append", exact: true }).click();
  await page.getByText("Appended 1 event").waitFor();
  // no optimistic row: the event arrives through the live subscription, credited to the person
  await page.getByRole("log", { name: "Events" }).getByText("appended in the browser").waitFor();
  const appended = (await fixture.itx.cd("/demo/one").readEvents(0, 100)).events.find(
    (event) =>
      event.type === "manual/note-added" && JSON.stringify(event.payload).includes("browser"),
  );
  // the fixture's person (test-support/forged-session.ts names them after the project's slug)
  expect(appended?.source?.principal?.email).toBe(`forged-${fixture.project.slug}@example.com`);
});

test("a long log opens at its newest events and reads older ones as the reader scrolls up", async ({
  page,
  baseURL,
  helpers,
}) => {
  helpers.appOrigin("dash");
  await using fixture = await helpers.createFixture("long-log", { app: baseURL });
  const log = fixture.itx.cd("/long");
  for (let batch = 0; batch < 3; batch += 1)
    await log.append(
      ...Array.from({ length: 1000 }, (_, index) => ({
        type: "manual/tick",
        payload: { n: batch * 1000 + index + 1 },
      })),
    );
  await page.goto(`/projects/${fixture.project.slug}/contexts/long`);
  // the newest page first, the rows virtual: a few dozen in the DOM, not thousands
  await page.getByRole("log", { name: "Events" }).getByText("n 3000", { exact: true }).waitFor();
  expect(await page.locator("[data-index]").count()).toBeLessThan(300);
  // older pages load as the feed scrolls up, until the log's first event
  const feed = page.getByRole("log", { name: "Events" });
  const first = feed.getByText("n 1", { exact: true });
  while (!(await first.isVisible())) {
    // to the top of what is loaded, which reads the page below it (a spinner while it does); once
    // the whole log is loaded there is no top row, the first event is the top
    await feed.hover();
    await page.mouse.wheel(0, -1_000_000);
    await feed.getByText(/^(Loading older events|Load older events|n 1)$/).waitFor();
  }
  expect(await page.locator("[data-index]").count()).toBeLessThan(300);
});

test("an event opens in the inspector as YAML, and the arrow keys page the log", async ({
  page,
  baseURL,
  helpers,
}) => {
  helpers.appOrigin("dash");
  await using fixture = await helpers.createFixture("inspector", { app: baseURL });
  await fixture.itx
    .cd("/pages")
    .append(
      { type: "manual/first-added", payload: { n: 1 } },
      { type: "manual/second-added", payload: { n: 2 } },
    );
  await page.goto(`/projects/${fixture.project.slug}/contexts/pages`);
  await page.getByRole("log", { name: "Events" }).getByText("manual/second-added").click();
  const inspector = page.getByRole("dialog");
  await inspector.getByRole("heading", { name: "manual/second-added" }).waitFor();
  await inspector.getByText("type: manual/second-added").waitFor();
  // ← the event before, → back again; each step is the page's URL
  await page.keyboard.press("ArrowLeft");
  await inspector.getByRole("heading", { name: "manual/first-added" }).waitFor();
  await page.keyboard.press("ArrowRight");
  await inspector.getByRole("heading", { name: "manual/second-added" }).waitFor();
});
