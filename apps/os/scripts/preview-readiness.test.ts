import { expect, test, vi } from "vitest";
import { awaitFullRounds } from "./preview-readiness.ts";

test("awaitFullRounds: a brand-new preview's misses reset the streak, each one a platform-failure warn; ready after the full rounds in a row", async () => {
  const warn = captureWarn();
  // the shape measured on brand-new previews (2026-09-24): every probe missing, then fewer, then none
  const rounds = [
    [miss, miss],
    [miss, ok],
    [ok, ok],
    [miss, ok],
    [ok, ok],
    [ok, ok],
    [ok, ok],
  ];
  let calls = 0;
  const ready = await awaitFullRounds(async () => rounds[calls++]!, {
    label: "https://pr1-os-preview.example",
    consecutive: 3,
    deadlineMs: 60_000,
    pauseMs: 0,
  });
  expect({ calls, rounds: ready.rounds, misses: ready.misses.length }).toEqual({
    calls: 7,
    rounds: 7,
    misses: 4,
  });
  expect(warn.calls.map((line) => JSON.parse(line))).toMatchObject([
    {
      event: "preview.platform-failure-readiness",
      url: "https://pr1-os-preview.example",
      round: 1,
      stage: "whoami",
      detail: "internal error; reference = abc",
    },
    { round: 1 },
    { round: 2 },
    { round: 4 },
  ]);
});

test("awaitFullRounds: a preview still missing at the deadline fails the deploy, naming its misses", async () => {
  const warn = captureWarn();
  await expect(
    awaitFullRounds(async () => [miss], {
      label: "https://pr2-os-preview.example",
      consecutive: 3,
      deadlineMs: 20,
      pauseMs: 5,
    }),
  ).rejects.toThrow(
    /preview https:\/\/pr2-os-preview\.example was not ready within 0\.02 s: (\d+) of \1 probes missed[\s\S]*whoami: internal error; reference = abc/,
  );
  expect(warn.calls.length).toBeGreaterThan(0);
});

test("awaitFullRounds: a preview that answers at once passes after exactly the rounds asked for, no warn", async () => {
  const warn = captureWarn();
  let calls = 0;
  await awaitFullRounds(
    async () => {
      calls++;
      return [ok, ok, ok];
    },
    { label: "https://pr3-os-preview.example", consecutive: 3, deadlineMs: 60_000, pauseMs: 0 },
  );
  expect({ calls, warns: warn.calls.length }).toEqual({ calls: 3, warns: 0 });
});

const ok = { ok: true as const, ms: 5 };
const miss = { ok: false as const, stage: "whoami", detail: "internal error; reference = abc" };

/** console.warn (the misses) and console.log (the verdict) captured for one test; `calls` are
 *  the warns' first arguments. */
function captureWarn() {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  return {
    get calls() {
      return warn.mock.calls.map(([first]) => String(first));
    },
  };
}
