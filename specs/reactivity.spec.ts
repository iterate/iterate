import type { Page } from "@playwright/test";
import { test } from "./test-support/test.ts";

test("reactivity page repaints from a stream subscription after a page action", async ({
  helpers,
  page,
}) => {
  await using projectFixture = await helpers.createFixture("reactivity");

  await page.goto(`/projects/${projectFixture.project.slug}/reactivity`);
  await page.getByTestId("reactivity-stream-status").getByText("live").waitFor();
  await page.getByTestId("reactivity-project-id").getByText(projectFixture.project.id).waitFor();

  const initialEventCount = await metricNumber(page, "reactivity-stream-event-count");

  await page.getByRole("button", { name: "Append stream event" }).click();

  await page.getByTestId("reactivity-event-list").getByText("reactivity-event-1").waitFor();
  await page
    .getByTestId("reactivity-stream-event-count")
    .getByText(String(initialEventCount + 1), { exact: true })
    .waitFor();
});

test("reactivity page appends a batch and renders every delivered marker", async ({
  helpers,
  page,
}) => {
  await using projectFixture = await helpers.createFixture("reactivity-batch");

  await page.goto(`/projects/${projectFixture.project.slug}/reactivity`);
  await page.getByTestId("reactivity-stream-status").getByText("live").waitFor();

  const initialEventCount = await metricNumber(page, "reactivity-stream-event-count");

  await page.getByRole("button", { name: "Append stream batch" }).click();

  await page.getByTestId("reactivity-event-list").getByText("reactivity-batch-1-1").waitFor();
  await page.getByTestId("reactivity-event-list").getByText("reactivity-batch-1-2").waitFor();
  await page.getByTestId("reactivity-event-list").getByText("reactivity-batch-1-3").waitFor();
  await page
    .getByTestId("reactivity-stream-event-count")
    .getByText(String(initialEventCount + 3), { exact: true })
    .waitFor();
});

test("reactivity page replays already appended events after reload", async ({ helpers, page }) => {
  await using projectFixture = await helpers.createFixture("reactivity-replay");

  await page.goto(`/projects/${projectFixture.project.slug}/reactivity`);
  await page.getByTestId("reactivity-stream-status").getByText("live").waitFor();
  await page.getByRole("button", { name: "Append stream event" }).click();
  await page.getByTestId("reactivity-event-list").getByText("reactivity-event-1").waitFor();

  await page.reload();

  await page.getByTestId("reactivity-stream-status").getByText("live").waitFor();
  await page.getByTestId("reactivity-event-list").getByText("reactivity-event-1").waitFor();
  await page.getByTestId("reactivity-stream-event-count").getByText("1", { exact: true }).waitFor();
});

test("reactivity page delivers an appended event to another open tab", async ({
  context,
  helpers,
  page,
}) => {
  await using projectFixture = await helpers.createFixture("reactivity-tabs");
  const otherPage = await context.newPage();
  try {
    await page.goto(`/projects/${projectFixture.project.slug}/reactivity`);
    await otherPage.goto(`/projects/${projectFixture.project.slug}/reactivity`);
    await page.getByTestId("reactivity-stream-status").getByText("live").waitFor();
    await otherPage.getByTestId("reactivity-stream-status").getByText("live").waitFor();

    await page.getByRole("button", { name: "Append stream event" }).click();

    await page.getByTestId("reactivity-event-list").getByText("reactivity-event-1").waitFor();
    await otherPage.getByTestId("reactivity-event-list").getByText("reactivity-event-1").waitFor();
  } finally {
    await otherPage.close();
  }
});

async function metricNumber(page: Page, testId: string) {
  const text = await page.getByTestId(testId).textContent();
  const value = Number(text);
  if (!Number.isFinite(value)) {
    throw new Error(`Expected ${testId} to contain a number, got ${JSON.stringify(text)}`);
  }
  return value;
}
