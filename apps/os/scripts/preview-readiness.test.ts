import { expect, test, vi } from "vitest";
import { awaitFullRounds } from "./preview-readiness.ts";

test("awaitFullRounds: a brand-new preview's misses reset the streak, each one a platform-failure warn; ready after the full rounds in a row", async () => {
  using warn = captureWarn();
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
  using warn = captureWarn();
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
  using warn = captureWarn();
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

test("awaitFullRounds: holdMs keeps asking past the streak, and a miss inside the hold (an in-place redeploy's old version resetting) starts the streak again", async () => {
  using warn = captureWarn();
  vi.useFakeTimers();
  try {
    let calls = 0;
    const ready = awaitFullRounds(
      async () => {
        calls++;
        // the reset lands on the 7th round, after a full streak
        return calls === 7 ? [miss, ok] : [ok, ok];
      },
      {
        label: "https://main-os-preview.example",
        consecutive: 3,
        deadlineMs: 60_000,
        pauseMs: 100,
        holdMs: 5_000,
      },
    );
    await vi.runAllTimersAsync();
    const { ms, misses } = await ready;
    expect(ms).toBeGreaterThanOrEqual(5_000);
    expect({ misses: misses.length, warns: warn.calls.length }).toEqual({ misses: 1, warns: 1 });
    // three full rounds in a row after the miss before it lets go
    expect(calls).toBeGreaterThanOrEqual(10);
  } finally {
    vi.useRealTimers();
  }
});

const ok = { ok: true as const, ms: 5 };
const miss = { ok: false as const, stage: "whoami", detail: "internal error; reference = abc" };

/** console.warn (the misses) and console.log (the verdict) captured for one test, restored on
 *  dispose; `calls` are the warns' first arguments. */
function captureWarn() {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  return {
    get calls() {
      return warn.mock.calls.map(([first]) => String(first));
    },
    [Symbol.dispose]: () => {
      warn.mockRestore();
      log.mockRestore();
    },
  };
}
