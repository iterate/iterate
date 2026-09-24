import { expect, test, vi } from "vitest";
import { cfBrowser, unwrapBrowserRunQuickAction } from "./browser.ts";

// The unwrap contract behind itx.browser.quickAction: callers get the
// action's RESULT, never the binding's Response envelope. The binding is an
// external service (local dev cannot dial it), so this pure function carries the
// contract.

test("unwrapBrowserRunQuickAction: returns the envelope's result for successful JSON actions", async () => {
  await expect(
    unwrapBrowserRunQuickAction("markdown", json({ success: true, result: "# Hello" })),
  ).resolves.toBe("# Hello");
  await expect(
    unwrapBrowserRunQuickAction(
      "links",
      json({ success: true, result: ["https://a", "https://b"] }),
    ),
  ).resolves.toEqual(["https://a", "https://b"]);
});

test("unwrapBrowserRunQuickAction: throws the envelope's error on failure", async () => {
  await expect(
    unwrapBrowserRunQuickAction("markdown", json({ success: false, error: "page timed out" })),
  ).rejects.toThrow(/Browser Run markdown failed: "page timed out"/);
});

test("unwrapBrowserRunQuickAction: returns binary media as bytes", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const result = await unwrapBrowserRunQuickAction(
    "screenshot",
    new Response(png, { headers: { "content-type": "image/png" } }),
  );
  expect(result).toBeInstanceOf(Uint8Array);
  expect([...(result as Uint8Array)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
});

test("unwrapBrowserRunQuickAction: passes through JSON that is not the success/result envelope", async () => {
  await expect(unwrapBrowserRunQuickAction("json", json({ title: "raw" }))).resolves.toEqual({
    title: "raw",
  });
});

// ── Browser Run's own timeout ── `{"code":6002,"message":"A timeout was reached. …","detail":"Promise
// timed out"}` on a one-line inline-HTML screenshot (PR #2934 553ab630, 2026-09-24 00:20 UTC): nothing
// remote to wait for, so the timeout is the service's. A quick action on inline HTML retries it ONCE,
// a second later, logged; a second one surfaces, and a `url` page's timeout (maybe the site's) and
// every other failure are never retried.
test("quickAction on inline HTML: one retry, a second later, logged as browser.platform-failure-retry", async () => {
  const { calls, browser } = binding(timedOut, () => new Response(png));
  expect(await settle(() => browser.quickAction("screenshot", inline))).toMatchObject({
    value: png,
    retries: [
      {
        event: "browser.platform-failure-retry",
        action: "screenshot",
        message: expect.stringContaining('"code":6002'),
      },
    ],
  });
  expect(calls).toEqual(["screenshot", "screenshot"]);
});

test("quickAction's timeout retry is bounded: a second timeout surfaces; a url page's timeout and any other failure are never retried", async () => {
  const twice = binding(timedOut, timedOut);
  expect(await settle(() => twice.browser.quickAction("screenshot", inline))).toMatchObject({
    error: { message: expect.stringContaining('"code":6002') },
    retries: [{ event: "browser.platform-failure-retry" }],
  });
  expect(twice.calls).toHaveLength(2);

  const site = binding(timedOut, () => new Response(png));
  expect(
    await settle(() => site.browser.quickAction("screenshot", { url: "https://example.com" })),
  ).toMatchObject({ error: { message: expect.stringContaining('"code":6002') }, retries: [] });
  expect(site.calls).toHaveLength(1);

  const other = binding(
    () =>
      new Response(JSON.stringify({ success: false, error: "page crashed" }), {
        headers: { "content-type": "application/json" },
      }),
    () => new Response(png),
  );
  expect(await settle(() => other.browser.quickAction("screenshot", inline))).toMatchObject({
    error: { message: 'Browser Run screenshot failed: "page crashed"' },
    retries: [],
  });
  expect(other.calls).toHaveLength(1);
});

/** Run a quick action with the retry's wait elapsed at once: its answer or error, and the warns it
 *  logged. */
async function settle<T>(run: () => Promise<T>) {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const outcome = run().then(
      (value) => ({ value }),
      (error: Error) => ({ error }),
    );
    await vi.runAllTimersAsync();
    return { ...(await outcome), retries: warn.mock.calls.map(([entry]) => entry) };
  } finally {
    warn.mockRestore();
    vi.useRealTimers();
  }
}

/** A JSON Response, as the Browser Run binding answers. */
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const timedOut = () =>
  new Response(
    JSON.stringify({
      success: false,
      errors: [
        {
          code: 6002,
          message:
            "A timeout was reached. Check gotoOptions/waitForSelector/waitForTimeout/actionTimeout options.",
          detail: "Promise timed out",
        },
      ],
    }),
    { headers: { "content-type": "application/json" } },
  );
/** A binding whose quick actions answer `answers` in turn, and the calls it saw. */
const binding = (...answers: (() => Response)[]) => {
  const calls: string[] = [];
  const run = {
    quickAction: async (action: string) => {
      calls.push(action);
      return answers[calls.length - 1]!();
    },
  } as unknown as BrowserRun;
  return { calls, browser: cfBrowser(run) };
};
const inline = { html: "<!doctype html><body>Tuesday</body>" };
