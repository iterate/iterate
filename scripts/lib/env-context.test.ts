import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { temporaryDirectory } from "@iterate-com/shared/test-support/temporary-directory";
import { expect, onTestFinished, test, vi } from "vitest";
import { cloudflareApi, dopplerSecret } from "./env-context.ts";
import { fakeDoppler } from "./fake-doppler.ts";

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

test.for<{
  name: string;
  answer: Parameters<typeof fakeDoppler>[0];
  outcome: { value: string } | { error: string };
}>([
  {
    name: "a secret is its config's, downloaded",
    answer: { secrets: { SLACK_CI_BOT_TOKEN: "xoxb" } },
    outcome: { value: "xoxb" },
  },
  {
    name: "a config without the secret is an error naming both",
    answer: { secrets: { OTHER: "value" } },
    outcome: { error: "Doppler _shared/prd has no SLACK_CI_BOT_TOKEN" },
  },
  {
    name: "a download Doppler refuses is an error with its reason",
    answer: { refusal: "Doppler Error: Invalid Auth token" },
    outcome: {
      error:
        "doppler secrets download --project _shared --config prd failed: Doppler Error: Invalid Auth token",
    },
  },
])("dopplerSecret: $name", ({ answer, outcome }) => {
  using doppler = fakeDoppler(answer);
  const read = () => {
    try {
      return { value: dopplerSecret("_shared", "prd", "SLACK_CI_BOT_TOKEN") };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };
  expect(read()).toEqual(outcome);
  expect(doppler.calls()).toEqual([
    [
      "secrets",
      "download",
      "--no-file",
      "--format",
      "json",
      "--project",
      "_shared",
      "--config",
      "prd",
    ],
  ]);
});

// The test evidence upload's: fetched beside the tests into the job's file, read after them from it.
test("dopplerSecret with a fallback fetches the config into the file, then reads it offline", () => {
  using doppler = fakeDoppler({ secrets: { CLOUDFLARE_API_TOKEN: "token" } });
  using directory = temporaryDirectory();
  const fallback = join(directory.path, "doppler-shared-preview");
  const read = () => dopplerSecret("_shared", "preview", "CLOUDFLARE_API_TOKEN", { fallback });

  expect([read(), existsSync(fallback), read()]).toEqual(["token", true, "token"]);
  const download = ["secrets", "download", "--no-file", "--format", "json"];
  const of = ["--project", "_shared", "--config", "preview", "--fallback", fallback];
  expect(doppler.calls()).toEqual([
    [...download, ...of],
    [...download, ...of, "--fallback-only"],
  ]);
});

// Cloudflare's answers: the Artifacts API's 500/10400, its rate limit's 429, and a refusal.
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
  {
    // R2's NoSuchKey for an object delete (scripts/os/preview-delete.ts `GONE`)
    name: "a 200 whose envelope says `success: false` is the caller's CloudflareApiError, sent once",
    method: "DELETE",
    answers: [Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 200 })],
    outcome: { error: 'Cloudflare API DELETE /d1/query failed (200): [{"code":10007}]' },
  },
  {
    // the loser of two racing R2 bucket deletes (scripts/os/preview-delete.ts `deleteR2Bucket`)
    name: "a DELETE answered 500/10001 is sent again, and the retry's not-found is the caller's",
    method: "DELETE",
    answers: [
      Response.json({ success: false, errors: [{ code: 10001 }] }, { status: 500 }),
      Response.json({ success: false, errors: [{ code: 10006 }] }, { status: 404 }),
    ],
    outcome: { error: 'Cloudflare API DELETE /d1/query failed (404): [{"code":10006}]' },
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
