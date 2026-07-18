import { expect, test } from "@playwright/test";

// The whole point of the app in one test: two browsers on the same list URL
// converge through the Durable Object's live state — an add in one appears in
// the other without any reload, a toggle strikes through everywhere, and the
// rows survive a reload because they live in the DO's SQLite, not the page.
test("two browsers share one live todo list", async ({ browser }) => {
  const slug = `pw-${crypto.randomUUID().slice(0, 8)}`;
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  await pageA.goto(`/l/${slug}`);
  await pageB.goto(`/l/${slug}`);

  const composerA = pageA.getByLabel("add a todo");
  await composerA.fill("buy milk");
  await composerA.press("Enter");
  await expect(pageA.getByText("buy milk")).toBeVisible();
  // No action in B: the row arrives over B's own live-state subscription.
  await expect(pageB.getByText("buy milk")).toBeVisible();

  // click(), not check(): the checkbox is controlled and flips only when the
  // server's patch lands, which check()'s immediate did-it-change assertion
  // does not wait for.
  await pageB.getByLabel("done: buy milk").click();
  await expect(pageB.getByLabel("done: buy milk")).toBeChecked();
  await expect(pageA.getByLabel("done: buy milk")).toBeChecked();

  const composerB = pageB.getByLabel("add a todo");
  await composerB.fill("walk dog");
  await composerB.press("Enter");
  await expect(pageA.getByText("walk dog")).toBeVisible();

  // Rename in A propagates to B (prompt() is the whole rename UI).
  await pageA.evaluate(() => {
    window.prompt = () => "walk the dog twice";
  });
  await pageA.getByText("walk dog").dblclick();
  await expect(pageB.getByText("walk the dog twice")).toBeVisible();

  await pageA.getByLabel("delete: buy milk").click();
  await expect(pageB.getByText("buy milk")).not.toBeVisible();

  // Durability: a fresh page (new context, no client state) replays from the
  // Durable Object's SQLite.
  await pageA.reload();
  await expect(pageA.getByText("walk the dog twice")).toBeVisible();
  await expect(pageA.getByText("buy milk")).not.toBeVisible();

  await contextA.close();
  await contextB.close();
});
