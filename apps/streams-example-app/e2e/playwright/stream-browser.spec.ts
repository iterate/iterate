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

// The pre-itx-v4 hosted circuit-breaker processor (via the removed
// StreamProcessorRunner DO) is gone; on itx the pause door is core
// stream behavior, driven directly through the sidebar's pause/resume gate.
test("sidebar stream gate pauses and resumes ordinary appends", async ({ page }) => {
  const streamPath = `/e2e/${crypto.randomUUID()}`;
  await page.goto(streamRoute({ path: streamPath }));
  await expect(eventMeta(page, "events.iterate.com/stream/created").first()).toBeVisible();

  await expect(page.getByTestId("stream-gate-status")).toHaveText("Active", { timeout: 10_000 });
  await page.getByTestId("stream-pause-button").click();
  await expect(page.getByTestId("stream-control-action")).toHaveText("done");
  await expect(page.getByTestId("stream-gate-status")).toHaveText("Paused", { timeout: 10_000 });
  await expect(page.getByTestId("stream-pause-reason")).toContainText("operator pause");
  await expect(eventMeta(page, "events.iterate.com/stream/paused").first()).toBeVisible();

  // Ordinary appends are rejected while the gate is paused.
  await appendComposerEvent(page, {
    type: "events.iterate.com/debug/playwright-paused-rejected",
    payload: { streamPath, value: crypto.randomUUID() },
  });
  await expect(page.getByTestId("composer-state").first()).toHaveText("error");
  await expect(eventMeta(page, "events.iterate.com/debug/playwright-paused-rejected")).toHaveCount(
    0,
  );

  await page.getByTestId("stream-resume-button").click();
  await expect(page.getByTestId("stream-gate-status")).toHaveText("Active", { timeout: 10_000 });
  const afterResume = "events.iterate.com/debug/playwright-after-resume";
  await appendComposerEvent(page, {
    type: afterResume,
    payload: { streamPath, value: crypto.randomUUID() },
  });
  await expect(eventMeta(page, afterResume).first()).toBeVisible();
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
  // 8 = the 4-event birth certificate + this page's subscriber-connected + 3 appends.
  await expect(page.getByTestId("event-count")).toHaveText("8");

  await expect(page.getByLabel("Event type filter")).toContainText(primaryType);
  await page.getByLabel("Event type filter").selectOption(primaryType);
  await expect(page.getByTestId("event-count")).toHaveText("8");
  await expect(page.getByTestId("filter-count")).toHaveText("2 filtered events / 8 total events");
  await expect(eventMeta(page, primaryType)).toHaveCount(2);
  await expect(eventMeta(page, secondaryType)).toHaveCount(0);
  await expect(eventMeta(page, "events.iterate.com/stream/created")).toHaveCount(0);

  await appendComposerEvent(page, {
    type: secondaryType,
    payload: { streamPath, value: crypto.randomUUID() },
  });
  await expect(page.getByTestId("event-count")).toHaveText("9");
  await expect(eventMeta(page, secondaryType)).toHaveCount(0);

  await appendComposerEvent(page, {
    type: primaryType,
    payload: { streamPath, value: crypto.randomUUID() },
  });
  await expect(page.getByTestId("event-count")).toHaveText("10");
  await expect(page.getByTestId("filter-count")).toHaveText("3 filtered events / 10 total events");
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
  // 85 = birth certificate (4) + subscriber-connected + 80 random events.
  await expect(page.getByTestId("event-count")).toHaveText("85", { timeout: 30_000 });
  await expect(page.getByTestId("filter-count")).toHaveText("85 total events");

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
    /\d+ filtered events \/ 85 total events/,
  );
  await expect(eventMeta(page, selectedType).first()).toBeVisible();
});

// Regression for the OPFS wedge that made high-throughput sessions look like they "lost"
// events: navigating to a different stream kills the previous page's DB worker, which
// releases its Web Lock immediately but can leave its OPFS sync access handles open for a
// while. The next page's OPFSCoopSyncVFS init sweeps stale `.ahp-*` temp directories and —
// before patches/@journeyapps__wa-sqlite@1.7.0.patch — a removeEntry hitting that window
// threw NoModificationAllowedError, fatally rejecting VFS creation. Every reconnect
// re-failed the same way, so the new page showed no events and every append died, until a
// much later reload. The patch makes the sweep best-effort; this test drives the exact
// trigger: leave a page mid-bulk-ingest, then require the next stream to mirror and append.
test("navigating to a new stream mid-ingest still opens the new mirror and appends", async ({
  page,
}) => {
  const busyPath = `/e2e/${crypto.randomUUID()}`;
  await page.goto(streamRoute({ path: busyPath }));
  await expect(eventMeta(page, "events.iterate.com/stream/created").first()).toBeVisible();

  // Big enough that the mirror is still ingesting when we navigate away.
  await page.getByLabel("Count").fill("20000");
  await page.getByLabel("Batch size").fill("1000");
  await page.getByLabel("Seconds").fill("0");
  await page.getByRole("button", { name: "Stream random events" }).click();

  const nextPath = `/e2e/${crypto.randomUUID()}`;
  await page.goto(streamRoute({ path: nextPath }));

  await expect(eventMeta(page, "events.iterate.com/stream/created").first()).toBeVisible({
    timeout: 15_000,
  });
  const type = "events.iterate.com/debug/playwright-post-navigation";
  await appendComposerEvent(page, { type, payload: { nextPath } });
  await expect(eventMeta(page, type).first()).toBeVisible();
});

// Deterministic version of the wedge above: plant exactly the OPFS state the dead worker
// leaves behind — a `.ahp-*` temp directory whose Web Lock nobody holds but whose file has
// an open sync access handle (held here by a worker in a second tab, standing in for a
// terminated worker whose handles the browser has not released yet). The stream page's VFS
// sweep then deterministically hits NoModificationAllowedError on removeEntry; unpatched
// wa-sqlite turned that into "no database can open on this origin".
test("stale OPFS temp directory with open handles does not block the mirror", async ({
  context,
  page,
}) => {
  const handleHolder = await context.newPage();
  await handleHolder.goto("/blank");
  await handleHolder.evaluate(async () => {
    const workerSource = `
      (async () => {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle(".ahp-e2e-stale", { create: true });
        const file = await dir.getFileHandle("0.tmp", { create: true });
        // Held open for the page's lifetime; only sync access handles make
        // removeEntry throw NoModificationAllowedError.
        globalThis.heldHandle = await file.createSyncAccessHandle();
        postMessage("ready");
      })();
    `;
    const worker = new Worker(URL.createObjectURL(new Blob([workerSource])));
    await new Promise((resolve, reject) => {
      worker.onmessage = resolve;
      worker.onerror = (event) => reject(new Error(event.message));
    });
  });

  const streamPath = `/e2e/${crypto.randomUUID()}`;
  await page.goto(streamRoute({ path: streamPath }));
  await expect(eventMeta(page, "events.iterate.com/stream/created").first()).toBeVisible({
    timeout: 15_000,
  });
  const type = "events.iterate.com/debug/playwright-stale-ahp";
  await appendComposerEvent(page, { type, payload: { streamPath } });
  await expect(eventMeta(page, type).first()).toBeVisible();

  // Release the handle and remove the planted directory so later tests' sweeps
  // are not left deleting it (best-effort; the sweep also cleans it up).
  await handleHolder.close();
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

  const expectedCount = insertedCount + 5; // created + two feed configs + woken + subscriber-connected
  await expect(page.getByTestId("insert-state")).toHaveText("done", { timeout: 30_000 });
  await expect(page.getByTestId("event-count")).toHaveText(String(expectedCount), {
    timeout: 30_000,
  });
  const tailRow = page.locator(`[data-index='${expectedCount - 1}']`);
  await expect(tailRow.getByTestId("event-meta")).toBeVisible();
  await expect(tailRow).toHaveCSS("height", "40px");
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
  await page.goto(streamRoute({ path: streamPath, view: "browser-feed" }));
  await expect(page.getByTestId("feed-item-count")).not.toHaveText(/^0 feed items$/, {
    timeout: 30_000,
  });
  await expect(page.getByTestId("stream-status")).toHaveText("subscribed", { timeout: 30_000 });
  await expect.poll(() => feedDistanceFromEnd(page)).toBeLessThanOrEqual(2);
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
  // 5 = the 4-event birth certificate + this page's own subscriber-connected.
  await expect(page.getByTestId("event-count")).toHaveText("5");
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
  // 85 = birth certificate (4) + subscriber-connected + 80 random events.
  await expect(page.getByTestId("event-count")).toHaveText("85", { timeout: 30_000 });
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
  // 105 = birth certificate (4) + subscriber-connected + 100 random events.
  await expect(page.getByTestId("event-count")).toHaveText("105", { timeout: 30_000 });
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

  await expect(page.getByTestId("event-count")).toHaveText("5105", { timeout: 60_000 });
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
// Clicking the row is leaving-the-tail intent (the bottom stick releases on pointerdown, so an
// expansion is readable without being yanked), which means nothing re-pins the expanded JSON
// above the sticky composer.
test("expanding the tail event row at stream end stays above the composer", async ({ page }) => {
  // fixme, not test.fail: the regression's reproduction is timing-dependent —
  // under CI parallel load the expansion sometimes lands above the composer,
  // so a test.fail marker flip-flopped as an "unexpected pass" (first full
  // preview run of this suite, PR #2024). An explicit skip keeps the known
  // regression visible in every report without a nondeterministic verdict.
  // Re-enable as a plain test when the tail re-pin ships.
  test.fixme(true, "Known regression: expanded tail rows can grow under the sticky composer.");

  const streamPath = `/e2e/${crypto.randomUUID()}`;
  await page.goto(streamRoute({ path: streamPath }));
  await expect(eventMeta(page, "events.iterate.com/stream/created").first()).toBeVisible();

  await page.getByLabel("Count").fill("120");
  await page.getByLabel("Batch size").fill("120");
  await page.getByLabel("Seconds").fill("0");
  await page.getByRole("button", { name: "Stream random events" }).click();
  await expect(page.getByTestId("insert-state")).toHaveText("done", { timeout: 30_000 });
  // 125 = birth certificate (4) + subscriber-connected + 120 random events.
  await expect(page.getByTestId("event-count")).toHaveText("125", { timeout: 30_000 });
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
  // 165 = birth certificate (4) + subscriber-connected + 160 random events.
  await expect(page.getByTestId("event-count")).toHaveText("165", { timeout: 30_000 });

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

  const expectedCount = insertedCount + 5; // created + two feed configs + woken + subscriber-connected
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
    // 6 = birth certificate (4) + this page's subscriber-connected + 1 append.
    expect(sqliteScalar(dbPath, `SELECT COUNT(*) FROM events`)).toBe("6");
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
  // 5 = the 4-event birth certificate + this page's own subscriber-connected.
  await expect(page.getByTestId("event-count")).toHaveText("5");

  await page.getByRole("button", { name: "Kill" }).click();
  await expect(page.getByTestId("stream-status")).toHaveText("subscribed", { timeout: 30_000 });
  // The killed incarnation took every connection with it: the reboot appends a
  // fresh woken fact and the browser's reconnect a fresh subscriber-connected.
  await expect(page.getByTestId("event-count")).toHaveText("7", { timeout: 30_000 });
  await expect(eventMeta(page, "events.iterate.com/stream/woken")).toHaveCount(2);
});

// The stream DO can die at any moment (eviction, deploy, explicit kill) and browser-side
// appends must survive it with zero loss AND zero duplication: appendBatch stamps an
// idempotency key on every event and retries across the reconnect, so a batch that
// committed-but-lost-its-ack dedupes instead of double-appending, and one that never
// committed lands after the DO reboots.
test("killing the stream DO mid-blast loses no appends and duplicates none", async ({ page }) => {
  // History: CI-fixme'd the day this suite first ran unfiltered in preview CI
  // (PR #2024) — under 4-worker contention the double kill made appendBatch
  // reject (`insert-state: error`) in 2 of 3 preview runs while passing
  // serially everywhere. The fixme blamed the retry budget; the budget was
  // never consulted. The browser's WebSocket terminates at the WORKER, so a
  // kill mid-append rejects through a perfectly healthy session carrying the
  // DO's abort reason as a plain `Error("kill requested")` — and the mirror's
  // transient-classifier, which only knew socket shapes, surfaced the first
  // such rejection instead of retrying. (Serial runs mostly dodge the window;
  // contention widens it.) Fixed by the stream-unavailable error contract:
  // the worker door tags DO-lifecycle stub rejections (workerd's
  // `durableObjectReset` flag, which capnweb strips, is only visible there)
  // and appendBatch retries the tag — see
  // apps/os/src/domains/streams/stream-unavailable.ts. This test is the
  // regression proof under real kill timing.

  const streamPath = `/e2e/${crypto.randomUUID()}`;
  await page.goto(streamRoute({ path: streamPath }));
  await expect(eventMeta(page, "events.iterate.com/stream/created").first()).toBeVisible();

  const insertedCount = 3000;
  await page.getByLabel("Count").fill(String(insertedCount));
  await page.getByLabel("Batch size").fill("50");
  await page.getByLabel("Seconds").fill("3");
  await page.getByRole("button", { name: "Stream random events" }).click();
  await expect(page.getByTestId("insert-state")).toHaveText("inserting");

  // Kill the DO while the blast is in flight (twice, for good measure).
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Kill" }).click();
  await page.waitForTimeout(1_000);
  await page.getByRole("button", { name: "Kill" }).click();

  // The blast must still complete cleanly — retried batches, not errors.
  await expect(page.getByTestId("insert-state")).toHaveText("done", { timeout: 60_000 });

  // Exactly `insertedCount` generated events: none lost, none duplicated.
  // Control events (created/woken/subscriber-*) vary with the kills, so count
  // only the generated types via the filter dropdown.
  await expect
    .poll(
      () =>
        page.getByLabel("Event type filter").evaluate((element) => {
          if (!(element instanceof HTMLSelectElement)) throw new Error("not a select");
          return [...element.options]
            .filter((option) => option.value.startsWith("events.iterate.com/random/"))
            .reduce((sum, option) => sum + Number(/\((\d+)\)$/.exec(option.text)?.[1] ?? 0), 0);
        }),
      { timeout: 60_000 },
    )
    .toBe(insertedCount);
});

// Same guarantee from a FOLLOWER tab: appends ride the follower's own connection (no
// leadership required), survive a mid-blast DO kill, and both tabs' mirrors converge on
// the exact same count.
test("two tabs: follower blast survives a DO kill and both mirrors converge", async ({
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

  const leader = (await isLeader(page)) ? page : otherPage;
  const follower = leader === page ? otherPage : page;
  await expect(follower.getByTestId("subscription-status")).toContainText(/follower|leader/);

  const insertedCount = 2000;
  await follower.getByLabel("Count").fill(String(insertedCount));
  await follower.getByLabel("Batch size").fill("50");
  await follower.getByLabel("Seconds").fill("3");
  await follower.getByRole("button", { name: "Stream random events" }).click();
  await expect(follower.getByTestId("insert-state")).toHaveText("inserting");

  await leader.waitForTimeout(500);
  await leader.getByRole("button", { name: "Kill" }).click();

  await expect(follower.getByTestId("insert-state")).toHaveText("done", { timeout: 60_000 });

  const generatedCount = (scope: Page) =>
    scope.getByLabel("Event type filter").evaluate((element) => {
      if (!(element instanceof HTMLSelectElement)) throw new Error("not a select");
      return [...element.options]
        .filter((option) => option.value.startsWith("events.iterate.com/random/"))
        .reduce((sum, option) => sum + Number(/\((\d+)\)$/.exec(option.text)?.[1] ?? 0), 0);
    });
  await expect.poll(() => generatedCount(leader), { timeout: 60_000 }).toBe(insertedCount);
  await expect.poll(() => generatedCount(follower), { timeout: 60_000 }).toBe(insertedCount);
});

// A cold mirror far behind the head must PULL history (paged getEvents, client-paced)
// instead of letting the one-directional subscription blast the whole backlog at it —
// that's the flow-control fix for the 1M-replay memory blowup. This pins the behavior:
// a fresh browser context opening a stream thousands of events deep catches up exactly
// (no loss, no duplication) and ends live-subscribed.
test("cold open of a deep stream pull-pages history and converges exactly", async ({ browser }) => {
  const seedContext = await browser.newContext();
  const seedPage = await seedContext.newPage();
  const streamPath = `/e2e/${crypto.randomUUID()}`;
  await seedPage.goto(streamRoute({ path: streamPath }));
  await expect(eventMeta(seedPage, "events.iterate.com/stream/created").first()).toBeVisible();

  const insertedCount = 5000;
  await seedPage.getByLabel("Count").fill(String(insertedCount));
  await seedPage.getByLabel("Batch size").fill("500");
  await seedPage.getByLabel("Seconds").fill("0");
  await seedPage.getByRole("button", { name: "Stream random events" }).click();
  await expect(seedPage.getByTestId("insert-state")).toHaveText("done", { timeout: 60_000 });
  await seedContext.close();

  // Fresh context = fresh OPFS origin = checkpoint 0, thousands behind the head.
  const coldContext = await browser.newContext();
  const coldPage = await coldContext.newPage();
  const consoleLines: string[] = [];
  coldPage.on("console", (message) => consoleLines.push(message.text()));
  await coldPage.goto(streamRoute({ path: streamPath }));
  await expect(coldPage.getByTestId("stream-status")).toHaveText("subscribed", {
    timeout: 60_000,
  });
  await expect
    .poll(
      () =>
        coldPage.getByLabel("Event type filter").evaluate((element) => {
          if (!(element instanceof HTMLSelectElement)) throw new Error("not a select");
          return [...element.options]
            .filter((option) => option.value.startsWith("events.iterate.com/random/"))
            .reduce((sum, option) => sum + Number(/\((\d+)\)$/.exec(option.text)?.[1] ?? 0), 0);
        }),
      { timeout: 120_000 },
    )
    .toBe(insertedCount);
  // The catch-up must have gone through the pull lane, not the subscription blast.
  expect(
    consoleLines.some((line) =>
      line.includes("durable historical offsets before opening the live subscription"),
    ),
  ).toBe(true);
  await coldContext.close();
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
  // 6 = the 4-event birth certificate + this page's subscriber-connected + 1 append.
  await expect(page.getByTestId("event-count")).toHaveText("6");

  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.getByTestId("stream-status")).toHaveText("subscribed", { timeout: 30_000 });
  // The wiped stream births fresh (4 events) and this page reconnects (+1).
  await expect(page.getByTestId("event-count")).toHaveText("5", { timeout: 30_000 });
  await expect(eventMeta(page, type)).toHaveCount(0);
  await expect(eventMeta(page, "events.iterate.com/stream/created").first()).toBeVisible();
});

// The event-feed view hosts the unified browser-feed processor: specific-renderer events
// (created/woken) render as their own raw.* rows; consecutive events of the same type
// collapse into one raw.group row. A new type always starts a fresh row.
test("event-feed view renders specific renderers as singletons and groups by type", async ({
  page,
}) => {
  const streamPath = `/e2e/${crypto.randomUUID()}`;
  await page.goto(streamRoute({ path: streamPath, view: "browser-feed" }));

  await expect(
    page.locator("[data-testid='feed-item'][data-kind='raw.stream.created']"),
  ).toHaveCount(1);
  await expect(page.locator("[data-testid='feed-item'][data-kind='raw.stream.woken']")).toHaveCount(
    1,
  );
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
  await expect(page.getByTestId("stream-state")).toContainText("projectId");
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

  await page.getByTestId("view-link-browser-feed").click();
  await expect(page).toHaveURL(/view=browser-feed/);
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
    // Must match the lock a live mirror runtime requests, or the fresh tab below
    // would elect itself leader and this "empty follower" test would be vacuous.
    // Source of truth: streamMirrorWriterLockName + mirrorLockVersionVector in
    // apps/os/.../browser/stream-leader.ts. Format:
    //   stream-writer:<projectId>:<path>:browser-stream-mirror:<versionVector>
    // versionVector = the canonical members' `<slug>@<schemaVersion>` sorted and
    // joined by "|" (browser-feed@4, browser-raw-events@7). Bump here whenever a
    // member's schemaVersion changes — that bump is exactly what this lock guards.
    await new Promise<void>((resolve) => {
      void navigator.locks.request(
        `stream-writer:default:${path}:browser-stream-mirror:browser-feed@4|browser-raw-events@7`,
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
// frame-addressable), but the page's bottom stick deliberately releases only on user
// *input* events — programmatic scroll deltas are indistinguishable from the stick's own
// re-pin writes (see use-stick-to-bottom.ts). Each helper therefore dispatches an upward
// wheel event first: the same signal a real user reading older rows would produce.
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
  await page.getByTestId("stream-events").evaluate(async (element) => {
    if (!(element instanceof HTMLElement))
      throw new Error("stream scroller must be an HTMLElement");

    // Resolving every async row is not the end of virtualizer setup: each
    // newly rendered window is measured by ResizeObserver, and TanStack may
    // compensate scrollTop on the following frame. Sampling that correction
    // makes a healthy settled window look as if user scrolling reversed.
    const deadline = performance.now() + 5_000;
    let previousScrollTop = element.scrollTop;
    let stableFrames = 0;
    while (performance.now() < deadline) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const currentScrollTop = element.scrollTop;
      const hasPendingRows = element.querySelector("[data-testid='event-row-pending']") !== null;
      stableFrames =
        !hasPendingRows && Math.abs(currentScrollTop - previousScrollTop) <= 0.5
          ? stableFrames + 1
          : 0;
      if (stableFrames >= 3) return;
      previousScrollTop = currentScrollTop;
    }
    throw new Error(
      `virtual rows did not settle (scrollTop=${element.scrollTop}, pending=${element.querySelectorAll("[data-testid='event-row-pending']").length})`,
    );
  });
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
  const forwardJumps = frames
    .slice(1)
    .map((frame, index) => frame.scrollTop - frames[index].scrollTop);
  const largestForwardJump = Math.max(0, ...forwardJumps);
  const largestForwardJumpIndex = forwardJumps.indexOf(largestForwardJump) + 1;

  expect(
    longestUnhealthyRun,
    JSON.stringify(frames.filter((_, index) => unhealthy[index]).slice(0, 3)),
  ).toBeLessThanOrEqual(2);
  // Scroll position jumping forward is a determinism bug, never load noise.
  expect(
    largestForwardJump,
    JSON.stringify(
      frames.slice(
        Math.max(0, largestForwardJumpIndex - 2),
        Math.min(frames.length, largestForwardJumpIndex + 2),
      ),
    ),
  ).toBeLessThanOrEqual(2);
}
