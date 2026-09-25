// The Dash's context explorer (apps/dash/src/routes/_auth/projects/$slug/contexts.$.tsx): every
// context of a project, from the project's context registry, each opening live in the general-purpose
// context view (packages/ui context-view), which appends events and reads a long log newest first.
import { expect } from "@playwright/test";
import { test } from "../test-support/test.ts";

test("a project's contexts are listed from its registry, and one opens live and takes an appended event", async ({
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
  const underRoot = page.getByRole("region", { name: "Contexts under this path" });
  await underRoot.getByRole("link", { name: "demo/one", exact: true }).click();
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
  const start = feed.getByText("The start of the log");
  while (!(await start.isVisible())) {
    // to the top of what is loaded, which reads the page below it (a spinner while it does)
    await feed.hover();
    await page.mouse.wheel(0, -1_000_000);
    await feed
      .getByText(/^(Loading older events|The start of the log|Load older events)/)
      .waitFor();
  }
  await feed.getByText("n 1", { exact: true }).waitFor();
  expect(await page.locator("[data-index]").count()).toBeLessThan(300);
});
