import { tmpdir } from "node:os";
import { readFileSync, mkdtempDisposableSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
  appConfigSecretsOf,
  runCloudflareCommandWith429Retry,
  runAsync,
  smoke,
} from "./deploy-helpers.ts";

// ── appConfigSecretsOf ──
test("a deploy ships APP_CONFIG and every APP_CONFIG_ var beside it, and nothing else", () => {
  expect(
    appConfigSecretsOf({
      APP_CONFIG: "{}",
      APP_CONFIG_SECRETS__KEY: "key",
      APP_CONFIG_INTEGRATIONS__X: '{"oauthClientId":"id"}',
      APP_CONFIG_BLANK: "",
      APP_CONFIGURATION: "no",
      CLOUDFLARE_API_TOKEN: "token",
    }),
  ).toEqual({
    APP_CONFIG: "{}",
    APP_CONFIG_SECRETS__KEY: "key",
    APP_CONFIG_INTEGRATIONS__X: '{"oauthClientId":"id"}',
  });
});

// ── runAsync ──
test("resolves only after the child exits successfully", async () => {
  await expect(
    runAsync(process.execPath, ["--eval", "process.exit(0)"], { cwd: process.cwd() }),
  ).resolves.toBeUndefined();
});

test("rejects a nonzero child exit", async () => {
  await expect(
    runAsync(process.execPath, ["--eval", "process.exit(7)"], { cwd: process.cwd() }),
  ).rejects.toThrow("exited with 7");
});

// ── runCloudflareCommandWith429Retry ──
// The waits run on a fake clock that moves on whenever nothing else is left to run: CLOUDFLARE_API's
// schedule, kept, while the commands run for real.
test("runs a command Cloudflare's rate limit ended again, with a warn, until it succeeds", async () => {
  using directory = mkdtempDisposableSync(join(tmpdir(), "iterate-test-"));
  using warn = fakeClockAndWarns();
  const attemptFile = join(directory.path, "attempts");
  const script = `
      const fs = require("node:fs");
      const file = ${JSON.stringify(attemptFile)};
      const attempts = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0;
      fs.writeFileSync(file, String(attempts + 1));
      if (attempts === 0) {
        console.error("GET /workers/services/os-preview-7 -> 429 Too Many Requests");
        process.exit(1);
      }
    `;

  await expect(
    runCloudflareCommandWith429Retry(process.execPath, ["--eval", script], { cwd: process.cwd() }),
  ).resolves.toBeUndefined();

  expect(readFileSync(attemptFile, "utf8")).toBe("2");
  expect(warn.lines()).toMatchObject([
    { event: "cloudflare-api.platform-failure-retry", kind: "overloaded", attempt: 1 },
  ]);
});

test.for([
  { name: "a non-429 failure is not run again", stderr: "500 Internal Server Error", exit: 7 },
  {
    name: "a recovered 429 is not run again when a later unrelated error ends the command",
    stderr: "429 Too Many Requests\nERROR\n500 Internal Server Error",
    exit: 7,
  },
])("$name", async ({ stderr, exit }) => {
  using warn = fakeClockAndWarns();

  await expect(
    runCloudflareCommandWith429Retry(
      process.execPath,
      ["--eval", `console.error(${JSON.stringify(stderr)}); process.exit(${exit})`],
      { cwd: process.cwd() },
    ),
  ).rejects.toThrow(`exited with ${exit}`);
  expect(warn.lines()).toEqual([]);
});

test("the last 429 fails once the schedule is spent", async () => {
  using warn = fakeClockAndWarns();

  await expect(
    runCloudflareCommandWith429Retry(
      process.execPath,
      ["--eval", `console.error("429 Too Many Requests"); process.exit(1)`],
      { cwd: process.cwd() },
    ),
  ).rejects.toThrow("exited with 1");
  expect(warn.lines()).toMatchObject([
    { event: "cloudflare-api.platform-failure-retry", attempt: 1 },
    { event: "cloudflare-api.platform-failure-retry", attempt: 2 },
    { event: "cloudflare-api.platform-failure-retry", attempt: 3 },
    { event: "cloudflare-api.platform-failure-retry", attempt: 4 },
    { event: "cloudflare-api.platform-failure-retry", attempt: 5 },
    { event: "cloudflare-api.platform-failure-gave-up", attempts: 6 },
  ]);
});

// ── smoke ──
test("can require an exact response body rather than trusting the status alone", async () => {
  const fetchMock = vi.fn(async () => Response.json({ error: "not found" }, { status: 404 }));
  vi.stubGlobal("fetch", fetchMock);

  await expect(
    smoke(
      "https://auth-rpc-smoke.example.test/",
      async (response) => {
        const body = (await response.json()) as { error?: unknown };
        return response.status === 404 && body.error === "not found";
      },
      "auth Workers RPC",
    ),
  ).resolves.toBeUndefined();

  expect(fetchMock).toHaveBeenCalledOnce();
});

/** Fake timers that move on whenever nothing else is left to run, and console.warn's lines. */
function fakeClockAndWarns() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.setTimerTickMode("nextTimerAsync");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  return {
    lines: () => warn.mock.calls.map(([line]) => line),
    [Symbol.dispose]() {
      vi.useRealTimers();
    },
  };
}
