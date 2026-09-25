import { expect, test, vi } from "vitest";
import { fetchCloudflareWith429Retry } from "./cloudflare-429-retry.ts";

// Each row: what Cloudflare answers each call in turn (a status, a 429 with its Retry-After, or a
// fetch that throws), and what the caller gets (a status or the thrown message) after `sleeps`.
test.for([
  { name: "a 200 returns at once", answers: [200], outcome: 200, sleeps: [] },
  { name: "a 500 surfaces at once, never retried", answers: [500], outcome: 500, sleeps: [] },
  {
    name: "429s retry on the fallback schedule until a success",
    answers: [429, 429, 200],
    outcome: 200,
    sleeps: [5_000, 15_000],
  },
  {
    name: "Retry-After (delta-seconds) wins over the fallback delay, capped",
    answers: [{ retryAfter: "9" }, { retryAfter: "9999" }, 200],
    maxRetryAfterMs: 120_000,
    outcome: 200,
    sleeps: [9_000, 120_000],
  },
  {
    name: "the last 429 goes back to the caller's error path once the attempts are spent",
    answers: [429, 429, 429, 429, 429],
    backoffMs: [1, 1, 1, 1],
    outcome: 429,
    sleeps: [1, 1, 1, 1],
  },
  {
    name: "a thrown fetch error propagates, never retried",
    answers: [new Error("ECONNRESET")],
    outcome: "ECONNRESET",
    sleeps: [],
  },
])("$name", async ({ answers, backoffMs, maxRetryAfterMs, outcome, sleeps }) => {
  using warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const sleep = vi.fn(async (_ms: number) => {});
  let call = 0;
  const doFetch = vi.fn(async () => {
    const answer = answers[call++]!;
    if (answer instanceof Error) throw answer;
    if (typeof answer === "number") return new Response(null, { status: answer });
    return new Response(null, { status: 429, headers: { "retry-after": answer.retryAfter } });
  });

  const result = await fetchCloudflareWith429Retry("GET /d1/database", doFetch, {
    backoffMs,
    maxRetryAfterMs,
    sleep,
  }).then(
    (response) => response.status,
    (error: Error) => error.message,
  );

  expect(result).toBe(outcome);
  expect(doFetch).toHaveBeenCalledTimes(answers.length);
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(sleeps);
  expect(warn).toHaveBeenCalledTimes(sleeps.length);
});

test("each retry logs a cloudflare-api.rate-limited-retry warn", async () => {
  using warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const doFetch = vi
    .fn(async () => new Response(null, { status: 200 }))
    .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "9" } }));

  await fetchCloudflareWith429Retry("GET /workers", doFetch, { sleep: async () => {} });

  expect(warn).toHaveBeenCalledExactlyOnceWith({
    event: "cloudflare-api.rate-limited-retry",
    label: "GET /workers",
    attempt: 1,
    retryInMs: 9_000,
    retryAfterMs: 9_000,
  });
});
