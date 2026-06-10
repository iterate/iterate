import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { e2eStreamPath, streamRoute } from "../helpers.ts";

// Local reproduction of CI conditions (slow runner + real network to a deployed worker).
// Example: E2E_CPU_THROTTLE=6 E2E_NET_LATENCY_MS=100 WORKER_URL=https://... pnpm playwright.
// No-op unless the env vars are set, so CI and normal local runs are unaffected.
test.beforeEach(async ({ page }) => {
  const cpuThrottleRate = Number(process.env.E2E_CPU_THROTTLE ?? "1");
  const networkLatencyMs = Number(process.env.E2E_NET_LATENCY_MS ?? "0");
  if (cpuThrottleRate <= 1 && networkLatencyMs <= 0) return;
  const session = await page.context().newCDPSession(page);
  if (cpuThrottleRate > 1) {
    await session.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottleRate });
  }
  if (networkLatencyMs > 0) {
    await session.send("Network.enable");
    await session.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: networkLatencyMs,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  }
});

// Baseline end-to-end smoke test for the simplified browser mirror: a composer append must
// go to the server, be delivered back through the single elected subscriber, land in SQLite,
// and show up through the visible-range SQL query.
test("stream page appends through the shared browser mirror", async ({ page }) => {
  const streamPath = `/e2e/${crypto.randomUUID()}`;
  await page.goto(streamRoute({ path: streamPath }));

  await expect(eventMeta(page, "events.iterate.com/stream/created").first()).toBeVisible();

  const type = "events.iterate.com/debug/playwright-single";
  await appendComposerEvent(page, {
    type,
    payload: { streamPath, value: crypto.randomUUID() },
  });

  await expect(eventMeta(page, type).first()).toBeVisible();
});

test("sidebar circuit breaker config runs the hosted built-in processor", async ({ page }) => {
  const streamPath = `/e2e/${crypto.randomUUID()}`;
  await page.goto(streamRoute({ path: streamPath }));
  await expect(eventMeta(page, "events.iterate.com/stream/created").first()).toBeVisible();

  await page.getByTestId("circuit-breaker-burst-capacity").fill("1");
  await page.getByTestId("circuit-breaker-refill-rate").fill("1");
  await page.getByTestId("circuit-breaker-apply").click();
  await expect(page.getByTestId("stream-control-action")).toHaveText("done");
  await expect(
    eventMeta(page, "events.iterate.com/stream/subscription-configured").first(),
  ).toBeVisible();
  await expect(
    eventMeta(page, "events.iterate.com/circuit-breaker/configured").first(),
  ).toBeVisible();

  await appendComposerEvent(page, {
    type: "events.iterate.com/debug/playwright-circuit-breaker-first",
    payload: { streamPath, value: crypto.randomUUID() },
  });
  await appendComposerEvent(page, {
    type: "events.iterate.com/debug/playwright-circuit-breaker-second",
    payload: { streamPath, value: crypto.randomUUID() },
  });

  await expect(page.getByTestId("stream-pause-reason")).toContainText("circuit breaker", {
    timeout: 10_000,
  });
  await expect(page.getByTestId("stream-resume-button")).toBeVisible();
});

// Event type filtering should stay as simple as the stream page SQL: COUNT(*) over the
// generated type column plus the visible TanStack Virtual window over the same indexed type
// and local_index ordering. The downloaded DB query plan check catches accidental full scans.
test("event type filter uses the indexed SQLite type column", async ({ page }) => {
  const streamPath = `/e2e/${crypto.randomUUID()}`;
  await page.goto(streamRoute({ path: streamPath }));
  await expect(eventMeta(page, "events.iterate.com/stream/created").first()).toBeVisible();

  const primaryType = "events.iterate.com/debug/playwright-filter-primary";
  const secondaryType = "events.iterate.com/debug/playwright-filter-secondary";
  await appendComposerEvent(page, {
    type: primaryType,
    payload: { streamPath, value: crypto.randomUUID() },
  });
  await expect(eventMeta(page, primaryType).first()).toBeVisible();
  await appendComposerEvent(page, {
    type: secondaryType,
    payload: { streamPath, value: crypto.randomUUID() },
  });
  await expect(eventMeta(page, secondaryType).first()).toBeVisible();
  await appendComposerEvent(page, {
    type: primaryType,
    payload: { streamPath, value: crypto.randomUUID() },
  });
  await expect(eventMeta(page, primaryType)).toHaveCount(2);
  await expect(page.getByTestId("event-count")).toHaveText("6");

  await expect(page.getByLabel("Event type filter")).toContainText(primaryType);
  await page.getByLabel("Event type filter").selectOption(primaryType);
  await expect(page.getByTestId("event-count")).toHaveText("6");
  await expect(page.getByTestId("filter-count")).toHaveText("2 filtered events / 6 total events");
  await expect(eventMeta(page, primaryType)).toHaveCount(2);
  await expect(eventMeta(page, secondaryType)).toHaveCount(0);
  await expect(eventMeta(page, "events.iterate.com/stream/created")).toHaveCount(0);

  await appendComposerEvent(page, {
    type: secondaryType,
    payload: { streamPath, value: crypto.randomUUID() },
  });
  await expect(page.getByTestId("event-count")).toHaveText("7");
  await expect(eventMeta(page, secondaryType)).toHaveCount(0);

  await appendComposerEvent(page, {
    type: primaryType,
    payload: { streamPath, value: crypto.randomUUID() },
  });
  await expect(page.getByTestId("event-count")).toHaveText("8");
  await expect(page.getByTestId("filter-count")).toHaveText("3 filtered events / 8 total events");
  await expect(eventMeta(page, primaryType)).toHaveCount(3);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  const download = await downloadPromise;
  const tempDirectory = mkdtempSync(join(tmpdir(), "stream-browser-db-"));
  try {
    const dbPath = join(tempDirectory, download.suggestedFilename());
    await download.saveAs(dbPath);
    expect(
      sqliteScalar(
        dbPath,
        `SELECT COUNT(*) FROM events WHERE type = ${sqliteLiteral(primaryType)}`,
      ),
    ).toBe("3");
    expect(
      sqliteQueryPlan(
        dbPath,
        `SELECT COUNT(*) FROM events WHERE type = ${sqliteLiteral(primaryType)}`,
      ),
    ).toContain("events_type_local_index");
    expect(
      sqliteQueryPlan(
        dbPath,
        `SELECT local_index FROM events WHERE type = ${sqliteLiteral(primaryType)} ORDER BY local_index ASC LIMIT 10 OFFSET 0`,
      ),
    ).toContain("events_type_local_index");
  } finally {
    rmSync(tempDirectory, { force: true, recursive: true });
  }
});

// The sidebar bulk inserter is an operator toy for large-stream testing, not just a counter.
// It should generate varied, inspectable event types so the SQLite type filter can be tested
// against realistic-looking streams without hand-editing composer JSON for every row.
test("random bulk insert creates multiple filterable event types and shows filtered plus total counts", async ({
  page,
}) => {
  const streamPath = `/e2e/${crypto.randomUUID()}`;
  await page.goto(streamRoute({ path: streamPath }));
  await expect(eventMeta(page, "events.iterate.com/stream/created").first()).toBeVisible();

  await page.getByLabel("Count").fill("80");
  await page.getByLabel("Batch size").fill("80");
  await page.getByLabel("Seconds").fill("0");
  await page.getByRole("button", { name: "Stream random events" }).click();
  await expect(page.getByTestId("insert-state")).toHaveText("done", { timeout: 30_000 });
  await expect(page.getByTestId("event-count")).toHaveText("83", { timeout: 30_000 });
  await expect(page.getByTestId("filter-count")).toHaveText("83 total events");

  const generatedEventTypes = await page.getByLabel("Event type filter").evaluate((element) => {
    if (!(element instanceof HTMLSelectElement))
      throw new Error("event type filter must be a select");
    return [...element.options]
      .map((option) => option.value)
      .filter((value) => value.startsWith("events.iterate.com/random/"));
  });
  expect(generatedEventTypes.length).toBeGreaterThanOrEqual(3);

  const selectedType = generatedEventTypes[0];
  if (selectedType === undefined)
    throw new Error("random insert did not create a generated event type");
  await page.getByLabel("Event type filter").selectOption(selectedType);
  await expect(page.getByTestId("filter-count")).toHaveText(
    /\d+ filtered events \/ 83 total events/,
  );
  await expect(eventMeta(page, selectedType).first()).toBeVisible();
});

// Regression for initial tail anchoring from persisted local SQLite rows. A stream page that
// already has enough rows to scroll should mount at the newest rows after a reload, not at
// local_index 0. This is separate from "follow while appending": reload reconstructs the
// virtualizer from SQLite query results and must still settle at the tail.
test("stream page reload starts at the bottom of an existing local mirror", async ({ page }) => {
  const streamPath = `/e2e/${crypto.randomUUID()}`;
  await page.goto(streamRoute({ path: streamPath }));
  await expect(eventMeta(page, "events.iterate.com/stream/created").first()).toBeVisible();

  const insertedCount = 200;
  await page.getByLabel("Count").fill(String(insertedCount));
  await page.getByLabel("Batch size").fill(String(insertedCount));
  await page.getByLabel("Seconds").fill("0");
  await page.getByRole("button", { name: "Stream random events" }).click();

  const expectedCount = insertedCount + 3; // created + woken + subscriber-connected
  await expect(page.getByTestId("insert-state")).toHaveText("done", { timeout: 30_000 });
  await expect(page.getByTestId("event-count")).toHaveText(String(expectedCount), {
    timeout: 30_000,
  });
  await expect(page.locator(`[data-index='${expectedCount - 1}']`)).toBeVisible();
  await expectAtStreamEnd(page);

  await page.reload();

  // The reload tears down the old delivery connection and opens a new one, so
  // the server appends a subscriber-disconnected + subscriber-connected pair.
  const expectedCountAfterReload = expectedCount + 2;
  await expect(page.getByTestId("event-count")).toHaveText(String(expectedCountAfterReload), {
    timeout: 30_000,
  });
  await expect(page.locator("[data-index='0']")).toHaveCount(0);
  await expect(page.locator(`[data-index='${expectedCountAfterReload - 1}']`)).toBeVisible();
});

test("event feed view starts at the bottom on first visit while replay fills the mirror", async ({
  browser,
}) => {
  const streamPath = `/e2e/${crypto.randomUUID()}`;
  const setupContext = await browser.newContext();
  const setupPage = await setupContext.newPage();
  await setupPage.goto(streamRoute({ path: streamPath }));
  await expect(eventMeta(setupPage, "events.iterate.com/stream/created").first()).toBeVisible();

  const insertedCount = 200;
  await setupPage.getByLabel("Count").fill(String(insertedCount));
  await setupPage.getByLabel("Batch size").fill(String(insertedCount));
  await setupPage.getByLabel("Seconds").fill("0");
  await setupPage.getByRole("button", { name: "Stream random events" }).click();
  await expect(setupPage.getByTestId("insert-state")).toHaveText("done", { timeout: 30_000 });
  await setupContext.close();

  const freshContext = await browser.newContext();
  const page = await freshContext.newPage();
  await page.goto(streamRoute({ path: streamPath, view: "browser-event-feed" }));
  await expect(page.getByTestId("feed-item-count")).not.toHaveText(/^0 feed items$/, {
    timeout: 30_000,
  });
  await expect(page.getByTestId("stream-status")).toHaveText("subscribed", { timeout: 30_000 });
  await expectAtFeedEnd(page);
  await expect(page.getByTestId("feed-scroll-to-bottom-affordance")).toHaveCount(0);
  await freshContext.close();
});

// Guards "instant enough" first draw. This catches regressions where OPFS/wa-sqlite setup,
// subscription, or reactive query invalidation leaves the page hydrated but visually empty.
test("first event row draws quickly", async ({ page }) => {
  const streamPath = `/e2e/${crypto.randomUUID()}`;
  await page.goto(streamRoute({ path: streamPath }));
  await expect(eventMeta(page, "events.iterate.com/stream/created").first()).toBeVisible();

  const firstRowDrawMs = await page.evaluate(() => {
    const mark = performance.getEntriesByName("stream:first-event-row").at(-1);
    if (mark === undefined) throw new Error("missing stream:first-event-row performance mark");
    return mark.startTime;
  });
  expect(firstRowDrawMs).toBeLessThan(10_000);
});

// Proves two component-owned runtimes can point at one stream in one tab. The intended fix
// was to rely on the same Web Locks leadership election used across tabs, so one runtime
// writes and the other follows the shared OPFS mirror.
test("split view can mount the same stream twice and mirror appends", async ({ page }) => {
  const streamPath = `/e2e/${crypto.randomUUID()}`;
  await page.goto(
    `/split-stream?left=${encodeURIComponent(streamPath)}&right=${encodeURIComponent(streamPath)}`,
  );

  await expect(page.getByText(streamPath)).toHaveCount(2);
  await expect(eventMeta(page, "events.iterate.com/stream/created").first()).toBeVisible();

  const type = "events.iterate.com/debug/playwright-split";
  await appendComposerEvent(page, {
    type,
    payload: { streamPath, value: crypto.randomUUID() },
  });

  await expect(page.getByTestId("composer-state").first()).toHaveText("appended");
  await expect(eventMeta(page, type)).toHaveCount(2);
});

// Covers the original leadership requirement across browser tabs. Closing the elected writer
// must release the lock, promote the follower, reconnect, and keep future appends live.
test("two browser tabs update and hand off leadership after the writer closes", async ({
  context,
  page,
}) => {
  const streamPath = `/e2e/${crypto.randomUUID()}`;
  const otherPage = await context.newPage();

  await Promise.all([
    page.goto(streamRoute({ path: streamPath })),
    otherPage.goto(streamRoute({ path: streamPath })),
  ]);
  await Promise.all([
    expect(eventMeta(page, "events.iterate.com/stream/created").first()).toBeVisible(),
    expect(eventMeta(otherPage, "events.iterate.com/stream/created").first()).toBeVisible(),
  ]);

  const type = "events.iterate.com/debug/playwright-two-tabs";
  await appendComposerEvent(page, {
    type,
    payload: { streamPath, value: crypto.randomUUID() },
  });

  await Promise.all([
    expect(eventMeta(page, type).first()).toBeVisible(),
    expect(eventMeta(otherPage, type).first()).toBeVisible(),
  ]);

  const leader = (await isLeader(page)) ? page : otherPage;
  const follower = leader === page ? otherPage : page;
  await expect(follower.getByTestId("subscription-status")).toContainText(/follower|leader/);
  await leader.close();
  await expect(follower.getByTestId("subscription-status")).toHaveText("leader");

  const afterHandoffType = "events.iterate.com/debug/playwright-after-handoff";
  await appendComposerEvent(follower, {
    type: afterHandoffType,
    payload: { streamPath, value: crypto.randomUUID() },
  });
  await expect(eventMeta(follower, afterHandoffType).first()).toBeVisible();
});

// Deploy/schema-change regression. This reproduces the browser symptom where normal tabs
// got stuck on `connected`, `follower`, `Events: 0` after a deploy, while incognito worked.
// Old tabs can keep holding the previous unversioned Web Lock after new JS deploys and
// migrates the shared OPFS DB. A fresh runtime must not become a permanent follower behind
// that stale lock; its versioned lock should let it take over and replay server history.
test("fresh runtime takes over when a legacy writer lock is still held", async ({
  context,
  page,
}) => {
  const streamPath = `/e2e/${crypto.randomUUID()}`;
  const legacyLockHolder = await context.newPage();
  await legacyLockHolder.goto("/blank");
  await holdLegacyWriterLock(legacyLockHolder, streamPath);

  await page.goto(streamRoute({ path: streamPath }));
  await expect(page.getByTestId("subscription-status")).toHaveText("leader");
  await expect(page.getByTestId("event-count")).toHaveText("3");
  await expect(eventMeta(page, "events.iterate.com/stream/created").first()).toBeVisible();

  await legacyLockHolder.close();
});

// If this tab is only a follower and its local SQLite mirror is empty, the page must say so
// explicitly. This is the UI regression test for "no swallowed errors": this state may not
// throw in the current tab, so the feed itself must explain why rows are not loading.
test("empty follower state is visible in the stream UI", async ({ context, page }) => {
  const streamPath = `/e2e/${crypto.randomUUID()}`;
  const lockHolder = await context.newPage();
  await lockHolder.goto("/blank");
  await holdCurrentWriterLock(lockHolder, streamPath);

  await page.goto(streamRoute({ path: streamPath }));
  await expect(page.getByTestId("subscription-status")).toHaveText("follower");
  await expect(page.getByTestId("event-count")).toHaveText("0");
  await expect(page.getByTestId("stream-warning")).toContainText(
    "Follower with empty SQLite mirror",
  );

  await lockHolder.close();
});

// Split view should not imply any global singleton. Two different streams mounted side by
// side each own their stream runtime, database file, and leadership election.
test("split view keeps different streams isolated", async ({ page }) => {
  const leftPath = `/e2e/${crypto.randomUUID()}/left`;
  const rightPath = `/e2e/${crypto.randomUUID()}/right`;
  await page.goto(
    `/split-stream?left=${encodeURIComponent(leftPath)}&right=${encodeURIComponent(rightPath)}`,
  );

  const leftPane = splitPane(page, leftPath);
  const rightPane = splitPane(page, rightPath);
  await expect(leftPane.getByTestId("subscription-status")).toHaveText("leader");
  await expect(rightPane.getByTestId("subscription-status")).toHaveText("leader");

  const leftType = "events.iterate.com/debug/playwright-left-stream";
  const rightType = "events.iterate.com/debug/playwright-right-stream";
  await appendComposerEvent(leftPane, {
    type: leftType,
    payload: { streamPath: leftPath, value: crypto.randomUUID() },
  });
  await appendComposerEvent(rightPane, {
    type: rightType,
    payload: { streamPath: rightPath, value: crypto.randomUUID() },
  });

  await expect(eventMeta(leftPane, leftType).first()).toBeVisible();
  await expect(eventMeta(leftPane, rightType)).toHaveCount(0);
  await expect(eventMeta(rightPane, rightType).first()).toBeVisible();
  await expect(eventMeta(rightPane, leftType)).toHaveCount(0);
});

// Regression for the composer/scrollbar layout. The event list scrolls in its own pane and the
// composer sits below it (vanilla TanStack chat layout), so tail rows can grow without sliding
// under a sticky overlay. Growing the textarea must not break tail-following.
test("auto-growing composer stays in the stream scrollbar and preserves tail appends", async ({
  page,
}) => {
  const streamPath = `/e2e/${crypto.randomUUID()}`;
  await page.goto(streamRoute({ path: streamPath }));
  await expect(eventMeta(page, "events.iterate.com/stream/created").first()).toBeVisible();

  await expect
    .poll(async () => {
      return await page.evaluate(() => {
        const scroller = document.querySelector("[data-testid='stream-events']");
        const filterBar = document.querySelector("[data-testid='event-type-filter-bar']");
        if (!(scroller instanceof HTMLElement) || !(filterBar instanceof HTMLElement)) {
          throw new Error("missing stream scroller or filter bar");
        }
        return scroller.contains(filterBar);
      });
    })
    .toBe(true);
  await expectComposerAtScrollerBottom(page);
  await expect
    .poll(async () => {
      const rects = await page.evaluate(() => {
        const scroller = document.querySelector("[data-testid='stream-events']");
        if (!(scroller instanceof HTMLElement)) throw new Error("missing stream scroller");
        return {
          scrollerBottom: scroller.getBoundingClientRect().bottom,
          viewportBottom: window.innerHeight,
        };
      });
      return Math.round(rects.viewportBottom - rects.scrollerBottom);
    })
    .toBe(0);

  const textarea = page.getByLabel("Event JSON").first();
  const type = "events.iterate.com/debug/playwright-grown-composer";
  await textarea.fill(
    JSON.stringify(
      {
        type,
        payload: {
          lines: Array.from({ length: 40 }, (_, index) => `composer line ${index}`),
        },
      },
      null,
      2,
    ),
  );
  await expect
    .poll(
      async () =>
        await textarea.evaluate((element) => {
          if (!(element instanceof HTMLTextAreaElement))
            throw new Error("composer must be a textarea");
          return element.scrollHeight > element.clientHeight + 50;
        }),
    )
    .toBe(true);
  await expect
    .poll(async () => {
      const alignment = await page.evaluate(() => {
        const eventRow = document.querySelector('[data-testid="event-row"]');
        const composerTextarea = document.querySelector('[data-testid="composer-textarea"]');
        if (
          !(eventRow instanceof HTMLElement) ||
          !(composerTextarea instanceof HTMLTextAreaElement)
        ) {
          throw new Error("missing stream row or composer textarea");
        }
        const eventRect = eventRow.getBoundingClientRect();
        const textareaRect = composerTextarea.getBoundingClientRect();
        return {
          left: Math.round(Math.abs(eventRect.left - textareaRect.left)),
          right: Math.round(Math.abs(eventRect.right - textareaRect.right)),
        };
      });
      return `${alignment.left}:${alignment.right}`;
    })
    .toBe("0:0");

  await page.getByRole("button", { name: "Append event" }).first().click();
  await expect(page.getByTestId("composer-state").first()).toHaveText("appended");
  await expect(eventMeta(page, type).first()).toBeVisible();
  await expectAtStreamEnd(page);
  await scrollStreamBy(page, -120);
  await expectComposerAtScrollerBottom(page);
});

// Regression for the bottom affordance badge. When the user is reading older rows, appends
// should not force-scroll them, but the affordance should show how many new rows arrived since
// the last time they were at the tail.
test("scroll to bottom affordance counts new events while away from tail", async ({ page }) => {
  const streamPath = `/e2e/${crypto.randomUUID()}`;
  await page.goto(streamRoute({ path: streamPath }));
  await expect(eventMeta(page, "events.iterate.com/stream/created").first()).toBeVisible();

  await page.getByLabel("Count").fill("80");
  await page.getByLabel("Batch size").fill("80");
  await page.getByLabel("Seconds").fill("0");
  await page.getByRole("button", { name: "Stream random events" }).click();
  await expect(page.getByTestId("insert-state")).toHaveText("done", { timeout: 30_000 });
  await expect(page.getByTestId("event-count")).toHaveText("83", { timeout: 30_000 });
  await expectAtStreamEnd(page);

  await page.getByRole("button", { name: "Scroll to top" }).click();
  await expect(page.getByRole("button", { name: "Scroll to bottom" })).toBeVisible();

  const type = "events.iterate.com/debug/playwright-new-event-count";
  await appendComposerEvent(page, {
    type,
    payload: { streamPath, value: crypto.randomUUID() },
  });

  await expect(eventMeta(page, type)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Scroll to bottom, 1 new event" })).toBeVisible();
  await page.getByRole("button", { name: "Scroll to bottom, 1 new event" }).click();
  await expect(eventMeta(page, type).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Scroll to bottom, 1 new event" })).toHaveCount(0);
});

// Stress version of the unread badge. While 5,000 events are appended over several seconds,
// the user can keep scrolling around older rows; as long as they never touch the tail, the
// badge must keep accumulating exactly the number of rows appended since leaving the tail.
test("scroll to bottom affordance keeps counting while scrolling older rows during heavy append", async ({
  page,
}) => {
  const streamPath = `/e2e/${crypto.randomUUID()}`;
  await page.goto(streamRoute({ path: streamPath }));
  await expect(eventMeta(page, "events.iterate.com/stream/created").first()).toBeVisible();

  await page.getByLabel("Count").fill("100");
  await page.getByLabel("Batch size").fill("100");
  await page.getByLabel("Seconds").fill("0");
  await page.getByRole("button", { name: "Stream random events" }).click();
  await expect(page.getByTestId("insert-state")).toHaveText("done", { timeout: 30_000 });
  await expect(page.getByTestId("event-count")).toHaveText("103", { timeout: 30_000 });
  await expectAtStreamEnd(page);

  await scrollStreamBy(page, -500);
  await expect(page.getByRole("button", { name: "Scroll to bottom" })).toBeVisible();
  await expect.poll(() => streamDistanceFromEnd(page)).toBeGreaterThan(200);

  await page.getByLabel("Count").fill("5000");
  await page.getByLabel("Batch size").fill("100");
  await page.getByLabel("Seconds").fill("5");
  const scrollJitter = jitterScrollAwayFromBottom(page, { durationMs: 5_500, delta: 24 });
  await page.getByRole("button", { name: "Stream random events" }).click();
  await Promise.all([
    scrollJitter,
    expect(page.getByTestId("insert-state")).toHaveText("done", { timeout: 60_000 }),
  ]);

  await expect(page.getByTestId("event-count")).toHaveText("5103", { timeout: 60_000 });
  await expect(
    page.getByRole("button", { name: "Scroll to bottom, 5000 new events" }),
  ).toBeVisible();
  await expect.poll(() => streamDistanceFromEnd(page)).toBeGreaterThan(0);
  await expectComposerAtScrollerBottom(page);

  await page.getByRole("button", { name: "Scroll to bottom, 5000 new events" }).click();
  await expect(page.getByRole("button", { name: "Scroll to bottom, 5000 new events" })).toHaveCount(
    0,
  );
  await expectAtStreamEnd(page);
});

// Known failing regression: tail row expansion currently grows underneath the sticky composer.
// Leave this as a failing test for now. The rest of the stream uses TanStack Virtual's native
// chat behavior (`anchorTo: "end"` + `followOnAppend`) and we do not want custom scroll
// bookkeeping just to paper over this edge case.
test("expanding the tail event row at stream end stays above the composer", async ({ page }) => {
  test.fail(true, "Known regression: expanded tail rows can grow under the sticky composer.");

  const streamPath = `/e2e/${crypto.randomUUID()}`;
  await page.goto(streamRoute({ path: streamPath }));
  await expect(eventMeta(page, "events.iterate.com/stream/created").first()).toBeVisible();

  await page.getByLabel("Count").fill("120");
  await page.getByLabel("Batch size").fill("120");
  await page.getByLabel("Seconds").fill("0");
  await page.getByRole("button", { name: "Stream random events" }).click();
  await expect(page.getByTestId("insert-state")).toHaveText("done", { timeout: 30_000 });
  await expect(page.getByTestId("event-count")).toHaveText("123", { timeout: 30_000 });
  await expectAtStreamEnd(page);

  const tailRow = page.locator("[data-testid='virtual-row']").last().getByTestId("event-meta");
  await tailRow.click();
  await expect(tailRow).toHaveAttribute("aria-expanded", "true");

  const expandedJson = page.getByTestId("event-json").last();
  await expect(expandedJson).toBeVisible();
  await expect
    .poll(async () => {
      const layout = await page.evaluate(() => {
        const json = document.querySelector("[data-testid='event-json']:last-of-type");
        const composer = document.querySelector("[data-testid='stream-composer']");
        if (!(json instanceof HTMLElement) || !(composer instanceof HTMLElement)) {
          throw new Error("missing expanded json or composer");
        }
        const jsonRect = json.getBoundingClientRect();
        const composerRect = composer.getBoundingClientRect();
        return Math.round(composerRect.top - jsonRect.bottom);
      });
      return layout;
    })
    .toBeGreaterThan(4);
  await expectAtStreamEnd(page);
});

// Row expansion is local view state keyed by stream offset, not DOM state on the virtual row.
// This protects the common TanStack Virtual trap where an expanded row appears to "forget"
// itself after being scrolled out of the rendered window and mounted again later.
test("event row open and closed state survives virtual row unmounts", async ({ page }) => {
  const streamPath = `/e2e/${crypto.randomUUID()}`;
  await page.goto(streamRoute({ path: streamPath }));
  await expect(eventMeta(page, "events.iterate.com/stream/created").first()).toBeVisible();

  await page.getByLabel("Count").fill("160");
  await page.getByLabel("Batch size").fill("160");
  await page.getByLabel("Seconds").fill("0");
  await page.getByRole("button", { name: "Stream random events" }).click();
  await expect(page.getByTestId("insert-state")).toHaveText("done", { timeout: 30_000 });
  await expect(page.getByTestId("event-count")).toHaveText("163", { timeout: 30_000 });

  await page.getByRole("button", { name: "Scroll to top" }).click();
  const firstRow = eventRowByOffset(page, 1);
  await expect(firstRow).toBeVisible();
  await firstRow.click();
  await expect(firstRow).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("event-json")).toBeVisible();

  await page.getByRole("button", { name: "Scroll to bottom" }).click();
  await expect(firstRow).toHaveCount(0);
  await page.getByRole("button", { name: "Scroll to top" }).click();
  await expect(eventRowByOffset(page, 1)).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("event-json")).toBeVisible();

  await eventRowByOffset(page, 1).click();
  await expect(eventRowByOffset(page, 1)).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Scroll to bottom" }).click();
  await expect(eventRowByOffset(page, 1)).toHaveCount(0);
  await page.getByRole("button", { name: "Scroll to top" }).click();
  await expect(eventRowByOffset(page, 1)).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("event-json")).toHaveCount(0);
});

// Exercises disposal when one of two same-stream panes changes path. This prevents stale
// component-owned runtimes from keeping old WebSocket subscriptions or Web Lock candidates
// alive after React unmounts a pane.
test("split view disposes a replaced same-stream pane and keeps leadership", async ({ page }) => {
  const sharedPath = `/e2e/${crypto.randomUUID()}/shared`;
  const nextPath = `/e2e/${crypto.randomUUID()}/next`;
  await page.goto(
    `/split-stream?left=${encodeURIComponent(sharedPath)}&right=${encodeURIComponent(sharedPath)}`,
  );

  await expect(
    page.locator(`[data-stream-path='${cssString(e2eStreamPath(sharedPath))}']`),
  ).toHaveCount(2);
  // Two views of the same (path, processor) now SHARE one runtime/connection (within-tab
  // dedup), so both panes reflect that single runtime as the leader — no intra-tab follower.
  await expect
    .poll(async () =>
      (await page.getByTestId("subscription-status").allInnerTexts())
        .map((status) => status.toLowerCase())
        .sort()
        .join(","),
    )
    .toBe("leader,leader");

  await page.getByLabel("Left stream").fill(nextPath);
  await page.getByRole("button", { name: "Go to streams" }).click();

  const sharedPane = splitPane(page, sharedPath);
  const nextPane = splitPane(page, nextPath);
  await expect(sharedPane).toHaveCount(1);
  await expect(nextPane).toHaveCount(1);
  await expect(sharedPane.getByTestId("subscription-status")).toHaveText("leader");
  await expect(nextPane.getByTestId("subscription-status")).toHaveText("leader");

  const sharedType = "events.iterate.com/debug/playwright-shared-after-dispose";
  const nextType = "events.iterate.com/debug/playwright-next-after-dispose";
  await appendComposerEvent(sharedPane, {
    type: sharedType,
    payload: { streamPath: sharedPath, value: crypto.randomUUID() },
  });
  await appendComposerEvent(nextPane, {
    type: nextType,
    payload: { streamPath: nextPath, value: crypto.randomUUID() },
  });

  await expect(eventMeta(sharedPane, sharedType).first()).toBeVisible();
  await expect(eventMeta(sharedPane, nextType)).toHaveCount(0);
  await expect(eventMeta(nextPane, nextType).first()).toBeVisible();
  await expect(eventMeta(nextPane, sharedType)).toHaveCount(0);
});

// Main regression for the flicker/stutter report. It creates a large stream, verifies the DOM
// stays bounded by TanStack Virtual, then samples animation frames while scrolling upward from
// the tail and middle. The fix was to keep close to the TanStack chat setup and batch delivered
// server writes into one SQLite invalidation per animation frame.
test("large streams stay virtualized and can scroll from tail to earliest rows", async ({
  page,
}) => {
  const streamPath = `/e2e/${crypto.randomUUID()}`;
  await page.goto(streamRoute({ path: streamPath }));
  await expect(eventMeta(page, "events.iterate.com/stream/created").first()).toBeVisible();

  const insertedCount = 1_500;
  await page.getByLabel("Count").fill(String(insertedCount));
  await page.getByLabel("Batch size").fill("250");
  await page.getByLabel("Seconds").fill("0");
  await page.getByRole("button", { name: "Stream random events" }).click();
  await expect(page.getByTestId("insert-state")).toHaveText("done", { timeout: 30_000 });

  const expectedCount = insertedCount + 3; // created + woken + subscriber-connected
  await expect(page.getByTestId("event-count")).toHaveText(String(expectedCount), {
    timeout: 30_000,
  });
  await expect
    .poll(() => page.locator("[data-testid='event-meta']").count(), { timeout: 30_000 })
    .toBeLessThan(120);
  await expect(page.locator("[data-index='0']")).toHaveCount(0);
  await expect(page.locator(`[data-index='${expectedCount - 1}']`)).toBeVisible();
  await expectComposerAtScrollerBottom(page);
  await waitForVisibleRowsSettled(page);
  expectStableUpwardScroll(await sampleUpwardScroll(page, { stepCount: 60, scrollDelta: 10 }));
  await expectComposerAtScrollerBottom(page);

  await scrollToMiddle(page);
  await waitForVisibleRowsSettled(page);
  expectStableUpwardScroll(await sampleUpwardScroll(page, { stepCount: 80, scrollDelta: 8 }));
  await expectComposerAtScrollerBottom(page);

  await page.getByRole("button", { name: "Scroll to top" }).click();
  await expect(page.locator("[data-index='0']")).toBeVisible();
  await expect(page.locator(`[data-index='${expectedCount - 1}']`)).toHaveCount(0);

  await page.getByRole("button", { name: "Scroll to bottom" }).click();
  await expect(page.locator(`[data-index='${expectedCount - 1}']`)).toBeVisible();
});

// Verifies the raw SQLite export feature end to end. The downloaded browser OPFS mirror must
// be a real SQLite database that can be queried from disk, not just a blob with the right name.
test("downloaded SQLite file can be queried from disk", async ({ page }) => {
  const streamPath = `/e2e/${crypto.randomUUID()}`;
  await page.goto(streamRoute({ path: streamPath }));
  await expect(eventMeta(page, "events.iterate.com/stream/created").first()).toBeVisible();

  const type = "events.iterate.com/debug/playwright-download";
  await appendComposerEvent(page, {
    type,
    payload: { streamPath, value: crypto.randomUUID() },
  });
  await expect(eventMeta(page, type).first()).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  const download = await downloadPromise;
  const tempDirectory = mkdtempSync(join(tmpdir(), "stream-browser-db-"));
  try {
    const dbPath = join(tempDirectory, download.suggestedFilename());
    await download.saveAs(dbPath);
    expect(sqliteScalar(dbPath, `SELECT COUNT(*) FROM events`)).toBe("4");
    expect(sqliteScalar(dbPath, `SELECT COUNT(*) FROM events WHERE type = '${type}'`)).toBe("1");
  } finally {
    rmSync(tempDirectory, { force: true, recursive: true });
  }
});

// Reconnection test: killing the Durable Object should reconnect the browser subscriber and
// append the server's woken event instead of leaving the mirror stuck on a dead WebSocket.
test("kill reconnects and appends a new woken event", async ({ page }) => {
  const streamPath = `/e2e/${crypto.randomUUID()}`;
  await page.goto(streamRoute({ path: streamPath }));
  await expect(page.getByTestId("event-count")).toHaveText("3");

  await page.getByRole("button", { name: "Kill" }).click();
  await expect(page.getByTestId("stream-status")).toHaveText("subscribed", { timeout: 30_000 });
  // The killed incarnation took every connection with it: the reboot appends a
  // fresh woken fact and the browser's reconnect a fresh subscriber-connected.
  await expect(page.getByTestId("event-count")).toHaveText("5", { timeout: 30_000 });
  await expect(eventMeta(page, "events.iterate.com/stream/woken")).toHaveCount(2);
});

// Catches stale local OPFS mirrors after server reset. This is the deployed-worker race that
// led to old local rows surviving; the browser now discards impossible local state and shows
// the fresh server stream.
test("reset discards stale local rows and shows a fresh stream", async ({ page }) => {
  const streamPath = `/e2e/${crypto.randomUUID()}`;
  await page.goto(streamRoute({ path: streamPath }));

  const type = "events.iterate.com/debug/playwright-before-reset";
  await appendComposerEvent(page, {
    type,
    payload: { streamPath, value: crypto.randomUUID() },
  });
  await expect(eventMeta(page, type).first()).toBeVisible();
  await expect(page.getByTestId("event-count")).toHaveText("4");

  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.getByTestId("stream-status")).toHaveText("subscribed", { timeout: 30_000 });
  await expect(page.getByTestId("event-count")).toHaveText("3", { timeout: 30_000 });
  await expect(eventMeta(page, type)).toHaveCount(0);
  await expect(eventMeta(page, "events.iterate.com/stream/created").first()).toBeVisible();
});

// The event-feed view hosts the browser-event-feed processor: specific-renderer events
// (created/woken) render as their own rows; consecutive events of the same type collapse
// into one group row. A new type always starts a fresh row.
test("event-feed view renders specific renderers as singletons and groups by type", async ({
  page,
}) => {
  const streamPath = `/e2e/${crypto.randomUUID()}`;
  await page.goto(streamRoute({ path: streamPath, view: "browser-event-feed" }));

  await expect(
    page.locator("[data-testid='feed-item'][data-component='stream.created']"),
  ).toHaveCount(1);
  await expect(
    page.locator("[data-testid='feed-item'][data-component='stream.woken']"),
  ).toHaveCount(1);
  await expect(
    page.locator("[data-testid='feed-lifecycle-marker'][data-kind='created']"),
  ).toContainText("Durable object created");
  await expect(
    page.locator("[data-testid='feed-lifecycle-marker'][data-kind='woken']"),
  ).toContainText("Durable object woke up");

  await appendComposerEvent(page, { type: "events.iterate.com/debug/feed-a", payload: { v: 1 } });
  const groupA = page.locator(
    "[data-testid='feed-item'][data-event-type='events.iterate.com/debug/feed-a']",
  );
  await expect(groupA).toHaveCount(1);
  await expect(groupA).toHaveAttribute("data-event-count", "1");

  await appendComposerEvent(page, { type: "events.iterate.com/debug/feed-b", payload: { v: 2 } });
  await expect(groupA).toHaveAttribute("data-event-count", "1");
  const groupB = page.locator(
    "[data-testid='feed-item'][data-event-type='events.iterate.com/debug/feed-b']",
  );
  await expect(groupB).toHaveCount(1);
  await expect(groupB).toHaveAttribute("data-event-count", "1");

  await appendComposerEvent(page, { type: "events.iterate.com/debug/feed-a", payload: { v: 3 } });
  await expect(
    page.locator("[data-testid='feed-item'][data-event-type='events.iterate.com/debug/feed-a']"),
  ).toHaveCount(2);
  const lastGroupA = page
    .locator("[data-testid='feed-item'][data-event-type='events.iterate.com/debug/feed-a']")
    .last();
  await appendComposerEvent(page, { type: "events.iterate.com/debug/feed-a", payload: { v: 4 } });
  await expect(lastGroupA).toHaveAttribute("data-event-count", "2");
});

// The state view has no processor or table: it reads the stream's reduced + runtime state
// live over the runtimeState() RPC and renders it in a fixed-width block.
test("state view renders the stream runtime state over RPC", async ({ page }) => {
  const streamPath = `/e2e/${crypto.randomUUID()}`;
  await page.goto(streamRoute({ path: streamPath, view: "browser-state" }));
  await expect(page.getByTestId("stream-state")).toContainText("maxOffset", { timeout: 20_000 });
  await expect(page.getByTestId("stream-state")).toContainText("namespace");
});

// Regression for the root stream route: `/streams` is its own TanStack route, not the splat
// route with an empty param. It must still respect the same `?view=` search param.
test("root stream route respects the selected view", async ({ page }) => {
  await page.goto(streamRoute({ path: "/", view: "browser-state" }));
  await expect(page.getByTestId("stream-state")).toContainText("maxOffset", { timeout: 20_000 });
  await expect(page.getByTestId("stream-state")).toContainText('"path": "/"');
});

// The view switcher moves between the three sibling views, preserving the stream path.
test("view switcher navigates between the three views", async ({ page }) => {
  const streamPath = `/e2e/${crypto.randomUUID()}`;
  await page.goto(streamRoute({ path: streamPath }));
  await expect(eventMeta(page, "events.iterate.com/stream/created").first()).toBeVisible();

  await page.getByTestId("view-link-browser-event-feed").click();
  await expect(page).toHaveURL(/view=browser-event-feed/);
  await expect(page.getByTestId("feed-item-count")).toBeVisible();

  await page.getByTestId("view-link-browser-state").click();
  await expect(page).toHaveURL(/view=browser-state/);
  await expect(page.getByTestId("stream-state")).toContainText("maxOffset", { timeout: 20_000 });
});

function eventMeta(scope: Page | Locator, eventType: string) {
  return scope.locator("[data-testid='event-meta']", { hasText: eventType });
}

function eventRowByOffset(scope: Page | Locator, offset: number) {
  return scope.locator(`[data-testid='event-meta'][data-event-offset='${offset}']`);
}

async function appendComposerEvent(scope: Page | Locator, event: unknown) {
  await scope
    .getByLabel("Event JSON")
    .first()
    .fill(JSON.stringify(event, null, 2));
  await scope.getByRole("button", { name: "Append event" }).first().click();
}

function splitPane(page: Page, streamPath: string) {
  return page.locator(`[data-stream-path='${cssString(e2eStreamPath(streamPath))}']`);
}

async function isLeader(page: Page) {
  await expect(page.getByTestId("subscription-status")).toContainText(/leader|follower/);
  return (await page.getByTestId("subscription-status").innerText()) === "leader";
}

async function holdLegacyWriterLock(page: Page, streamPath: string) {
  await page.evaluate(async (path) => {
    await new Promise<void>((resolve) => {
      void navigator.locks.request(`stream-writer:${path}`, async () => {
        resolve();
        await new Promise(() => {});
      });
    });
  }, streamPath);
}

async function holdCurrentWriterLock(page: Page, streamPath: string) {
  await page.evaluate(async (path) => {
    await new Promise<void>((resolve) => {
      void navigator.locks.request(
        `stream-writer:default:${path}:browser-raw-events:v4`,
        async () => {
          resolve();
          await new Promise(() => {});
        },
      );
    });
  }, streamPath);
}

function sqliteScalar(dbPath: string, sql: string) {
  return execFileSync("sqlite3", [dbPath, "-batch", "-noheader", sql], {
    encoding: "utf8",
  }).trim();
}

function sqliteQueryPlan(dbPath: string, sql: string) {
  return sqliteScalar(dbPath, `EXPLAIN QUERY PLAN ${sql}`);
}

function sqliteLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function cssString(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

async function streamDistanceFromEnd(page: Page) {
  return await page.getByTestId("stream-events").evaluate((element) => {
    if (!(element instanceof HTMLElement))
      throw new Error("stream scroller must be an HTMLElement");
    return Math.round(element.scrollHeight - element.clientHeight - element.scrollTop);
  });
}

async function expectAtStreamEnd(page: Page) {
  await expect.poll(() => streamDistanceFromEnd(page)).toBeLessThanOrEqual(2);
}

async function feedDistanceFromEnd(page: Page) {
  return await page.getByTestId("event-feed").evaluate((element) => {
    if (!(element instanceof HTMLElement))
      throw new Error("event feed scroller must be an HTMLElement");
    return Math.round(element.scrollHeight - element.clientHeight - element.scrollTop);
  });
}

async function expectAtFeedEnd(page: Page) {
  await expect.poll(() => feedDistanceFromEnd(page)).toBeLessThanOrEqual(2);
}

async function composerDistanceFromScrollerBottom(page: Page) {
  return await page.evaluate(() => {
    const scroller = document.querySelector("[data-testid='stream-events']");
    const composer = document.querySelector('[data-testid="stream-composer"]');
    if (!(scroller instanceof HTMLElement) || !(composer instanceof HTMLElement)) {
      throw new Error("missing stream scroller or composer");
    }
    return Math.round(
      composer.getBoundingClientRect().top - scroller.getBoundingClientRect().bottom,
    );
  });
}

async function expectComposerAtScrollerBottom(page: Page) {
  await expect.poll(() => composerDistanceFromScrollerBottom(page)).toBeLessThanOrEqual(2);
}

// The scroll helpers below move the viewport with direct `scrollTop` writes (deterministic,
// frame-addressable), but the page's initial tail pin deliberately releases only on user
// *input* events — programmatic scroll deltas are indistinguishable from the virtualizer's
// own convergence writes (see use-initial-tail-scroll.ts). Each helper therefore dispatches
// a wheel event first: the same signal a real user reading older rows would produce.
async function scrollStreamBy(page: Page, delta: number) {
  await page.getByTestId("stream-events").evaluate((element, scrollDelta) => {
    if (!(element instanceof HTMLElement))
      throw new Error("stream scroller must be an HTMLElement");
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: scrollDelta }));
    element.scrollTop += scrollDelta;
  }, delta);
}

async function jitterScrollAwayFromBottom(
  page: Page,
  options: { durationMs: number; delta: number },
) {
  await page.getByTestId("stream-events").evaluate(async (element, jitterOptions) => {
    if (!(element instanceof HTMLElement))
      throw new Error("stream scroller must be an HTMLElement");
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: -jitterOptions.delta }));

    let direction = -1;
    const finishedAt = performance.now() + jitterOptions.durationMs;
    while (performance.now() < finishedAt) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const maxScrollTopAwayFromTail = Math.max(
        0,
        element.scrollHeight - element.clientHeight - 160,
      );
      const nextScrollTop = element.scrollTop + direction * jitterOptions.delta;
      if (nextScrollTop <= 0 || nextScrollTop >= maxScrollTopAwayFromTail) {
        direction *= -1;
      }
      element.scrollTop = Math.min(
        maxScrollTopAwayFromTail,
        Math.max(0, element.scrollTop + direction * jitterOptions.delta),
      );
    }
  }, options);
}

async function waitForVisibleRowsSettled(page: Page) {
  await expect.poll(() => page.locator("[data-testid='event-meta']").count()).toBeGreaterThan(0);
  await expect.poll(() => page.getByTestId("event-row-pending").count()).toBe(0);
}

async function scrollToMiddle(page: Page) {
  await page.getByTestId("stream-events").evaluate((element) => {
    if (!(element instanceof HTMLElement))
      throw new Error("stream scroller must be an HTMLElement");
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }));
    element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
  });
}

async function sampleUpwardScroll(page: Page, options: { stepCount: number; scrollDelta: number }) {
  return await page.getByTestId("stream-events").evaluate(async (element, scrollOptions) => {
    if (!(element instanceof HTMLElement))
      throw new Error("stream scroller must be an HTMLElement");
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: -scrollOptions.scrollDelta }));

    function frame() {
      const virtualRows = [...element.querySelectorAll('[data-testid="virtual-row"]')];
      const indexFor = (row: Element | undefined) => {
        const value = row?.getAttribute("data-index");
        return value === undefined || value === null ? null : Number(value);
      };

      return {
        clientHeight: element.clientHeight,
        firstIndex: indexFor(virtualRows[0]),
        lastIndex: indexFor(virtualRows.at(-1)),
        pendingRowCount: element.querySelectorAll('[data-testid="event-row-pending"]').length,
        renderedRowCount: element.querySelectorAll("[data-testid='event-meta']").length,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
      };
    }

    const frames = [frame()];
    for (let index = 0; index < scrollOptions.stepCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      element.scrollTop = Math.max(0, element.scrollTop - scrollOptions.scrollDelta);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      frames.push(frame());
    }
    return frames;
  }, options);
}

function expectStableUpwardScroll(frames: Awaited<ReturnType<typeof sampleUpwardScroll>>) {
  // A frame is unhealthy when its visible window is mostly unrendered: no
  // rendered rows at all, or more than a couple of pending placeholders. The
  // flicker regression this guards shows up as a SUSTAINED run of unhealthy
  // frames; a single unhealthy frame is sampling noise — on a loaded CI
  // runner one long requestAnimationFrame gap lets the scroll outrun row
  // loading for a frame (seen as renderedRowCount 0 / pendingRowCount 67 in
  // an otherwise healthy run), so per-frame zero tolerance flakes. Bound the
  // longest consecutive unhealthy run instead.
  const unhealthy = frames.map(
    (frame) => frame.renderedRowCount === 0 || frame.pendingRowCount > 2,
  );
  let longestUnhealthyRun = 0;
  let run = 0;
  for (const isUnhealthy of unhealthy) {
    run = isUnhealthy ? run + 1 : 0;
    longestUnhealthyRun = Math.max(longestUnhealthyRun, run);
  }
  const largestForwardJump = Math.max(
    0,
    ...frames.slice(1).map((frame, index) => frame.scrollTop - frames[index].scrollTop),
  );

  expect(
    longestUnhealthyRun,
    JSON.stringify(frames.filter((_, index) => unhealthy[index]).slice(0, 3)),
  ).toBeLessThanOrEqual(2);
  // Scroll position jumping forward is a determinism bug, never load noise.
  expect(largestForwardJump).toBeLessThanOrEqual(2);
}
