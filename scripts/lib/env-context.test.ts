import { execFileSync } from "node:child_process";
import { expect, onTestFinished, test, vi } from "vitest";
import { cloudflareApi } from "./env-context.ts";

test("native Node scripts can import and inspect Cloudflare API errors", () => {
  // Vitest transforms TypeScript; a native subprocess catches syntax that
  // Node cannot strip when preview's trpc-cli imports this module.
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { CloudflareApiError } from './env-context.ts';
       console.log(JSON.stringify(new CloudflareApiError('GET', '/workers', 404, { code: 10007 })));`,
    ],
    { cwd: import.meta.dirname, env: { ...process.env, NODE_OPTIONS: "" }, encoding: "utf8" },
  );
  expect(JSON.parse(output)).toMatchObject({
    name: "CloudflareApiError",
    method: "GET",
    path: "/workers",
    status: 404,
    details: { code: 10007 },
  });
});

// What the Artifacts API answered two PR-close repo deletes on 2026-09-23, on and off for nine
// minutes, and what a rate-limited preview deploy's D1 query met on 2026-07-14.
test.for([
  {
    name: "a DELETE Cloudflare failed with a 5xx is sent again",
    method: "DELETE",
    answers: [internalError(), success()],
    outcome: { result: null },
  },
  {
    name: "a POST Cloudflare failed with a 5xx is sent once: it may have run",
    method: "POST",
    answers: [internalError()],
    outcome: { error: expect.stringMatching(/^POST \/d1\/query answered HTTP 500: .*10400/u) },
  },
  {
    name: "a POST Cloudflare's rate limit refused is sent again: it never ran",
    method: "POST",
    answers: [new Response(null, { status: 429 }), success()],
    outcome: { result: null },
  },
  {
    name: "a refusal is the caller's CloudflareApiError, sent once",
    method: "DELETE",
    answers: [Response.json({ success: false, errors: [{ code: 10200 }] }, { status: 404 })],
    outcome: { error: 'Cloudflare API DELETE /d1/query failed (404): [{"code":10200}]' },
  },
])("cloudflareApi: $name", async ({ method, answers, outcome }) => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const answer of answers) fetch.mockResolvedValueOnce(answer);
  vi.stubGlobal("fetch", fetch);

  const settled = cloudflareApi("token")("/d1/query", { method, body: "{}" }).then(
    (result) => ({ result }),
    (error: Error) => ({ error: error.message }),
  );
  await vi.runAllTimersAsync();

  expect(await settled).toEqual(outcome);
  expect(fetch).toHaveBeenCalledTimes(answers.length);
});

function internalError() {
  return Response.json(
    { success: false, errors: [{ code: 10400, message: "An internal error occurred." }] },
    { status: 500 },
  );
}

function success() {
  return Response.json({ success: true, result: null });
}
