import { expect, type Page } from "@playwright/test";
import { connectAdminItx } from "./test-support/forged-session.ts";
import { test } from "./test-support/test.ts";

// Post-append delivery waits get an explicit backstop in addition to the
// page's `data-spinner` append progress. The browser store's stall self-heal
// (stream-browser-store liveness probe, #1501) needs up to ~30s to reconnect
// when a fresh stream's first delivery stalls
// (tasks/stream-subscriber-deliveries-stall-mid-turn.md). Killed runs
// 4dzf4jv6x1/nvbmgzlspl/91qtw6zt01 on 2026-07-10, one spec each time.
const DELIVERY_WAIT = { timeout: 30_000 };

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

  await page
    .getByTestId("reactivity-event-list")
    .getByText("reactivity-event-1")
    .waitFor(DELIVERY_WAIT);
  await page
    .getByTestId("reactivity-stream-event-count")
    .getByText(String(initialEventCount + 1), { exact: true })
    .waitFor(DELIVERY_WAIT);
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

  await page
    .getByTestId("reactivity-event-list")
    .getByText("reactivity-batch-1-1")
    .waitFor(DELIVERY_WAIT);
  await page
    .getByTestId("reactivity-event-list")
    .getByText("reactivity-batch-1-2")
    .waitFor(DELIVERY_WAIT);
  await page
    .getByTestId("reactivity-event-list")
    .getByText("reactivity-batch-1-3")
    .waitFor(DELIVERY_WAIT);
  await page
    .getByTestId("reactivity-stream-event-count")
    .getByText(String(initialEventCount + 3), { exact: true })
    .waitFor(DELIVERY_WAIT);
});

test("reactivity page replays already appended events after reload", async ({ helpers, page }) => {
  await using projectFixture = await helpers.createFixture("reactivity-replay");

  await page.goto(`/projects/${projectFixture.project.slug}/reactivity`);
  await page.getByTestId("reactivity-stream-status").getByText("live").waitFor();
  await page.getByRole("button", { name: "Append stream event" }).click();
  await page
    .getByTestId("reactivity-event-list")
    .getByText("reactivity-event-1")
    .waitFor(DELIVERY_WAIT);

  await page.reload();

  await page.getByTestId("reactivity-stream-status").getByText("live").waitFor();
  await page
    .getByTestId("reactivity-event-list")
    .getByText("reactivity-event-1")
    .waitFor(DELIVERY_WAIT);
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

    await page
      .getByTestId("reactivity-event-list")
      .getByText("reactivity-event-1")
      .waitFor(DELIVERY_WAIT);
    await otherPage
      .getByTestId("reactivity-event-list")
      .getByText("reactivity-event-1")
      .waitFor(DELIVERY_WAIT);
  } finally {
    await otherPage.close();
  }
});

test("reactivity page processor panel goes live and repaints from a server push", async ({
  baseURL,
  helpers,
  page,
}) => {
  await using projectFixture = await helpers.createFixture("reactivity-processor");

  await page.goto(`/projects/${projectFixture.project.slug}/reactivity`);
  // The processor panel must actually be LIVE (a live-state push
  // subscription), not silently erroring behind a loader fallback.
  await page.getByTestId("reactivity-status").getByText("live").waitFor();
  await page.getByTestId("reactivity-phase").getByText("ready").waitFor();

  // #1810 removed the processor-offset metric; "State updates" is its
  // live-state analogue (how many times the folded slice pushed).
  const pushesBefore = await metricNumber(page, "reactivity-state-push-count");

  // Birth a brand-new child stream SERVER-SIDE (no page interaction at all):
  // that changes the project's folded state (streams[]), and the server must
  // push the new fold into the open page.
  using adminSession = await connectAdminItx(baseURL!);
  using adminProject = adminSession.projects.get(projectFixture.project.id);
  using stream = adminProject.streams.get(`/spec-processor-push/${Date.now().toString(36)}`);
  await stream.append({
    type: "events.iterate.test/spec/processor-push",
    payload: {},
  });

  await expect
    .poll(() => metricNumber(page, "reactivity-state-push-count"))
    .toBeGreaterThan(pushesBefore);
});

async function metricNumber(page: Page, testId: string) {
  const text = await page.getByTestId(testId).textContent();
  const value = Number(text);
  if (!Number.isFinite(value)) {
    throw new Error(`Expected ${testId} to contain a number, got ${JSON.stringify(text)}`);
  }
  return value;
}
