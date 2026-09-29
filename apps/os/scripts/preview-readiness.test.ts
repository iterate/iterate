import { expect, onTestFinished, test, vi } from "vitest";
import { awaitFullRounds, awaitHostnamePropagation } from "./preview-readiness.ts";

test("awaitFullRounds: a brand-new preview's misses reset the streak, each one a platform-failure warn; ready after the full rounds in a row", async () => {
  const warn = fakeClockAndWarns();
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
  });
  // a round with a miss pauses 1 s
  expect({ calls, rounds: ready.rounds, misses: ready.misses.length, ms: ready.ms }).toEqual({
    calls: 7,
    rounds: 7,
    misses: 4,
    ms: 3_000,
  });
  expect(warn.calls.map((line) => JSON.parse(line))).toMatchObject([
    {
      event: "preview.platform-failure-readiness",
      url: "https://pr1-os-preview.example",
      round: 1,
      atMs: 0,
      stage: "whoami",
      detail: "internal error; reference = abc",
    },
    { round: 1, atMs: 0 },
    { round: 2, atMs: 1_000 },
    { round: 4, atMs: 2_000 },
  ]);
});

test("awaitFullRounds: a preview still missing at the deadline fails the deploy, naming its misses", async () => {
  const warn = fakeClockAndWarns();
  // a round a second, the deadline checked before each: the 151st, at 150 s, is the last
  await expect(
    awaitFullRounds(async () => [miss], {
      label: "https://pr2-os-preview.example",
      consecutive: 3,
    }),
  ).rejects.toThrow(
    /^preview https:\/\/pr2-os-preview\.example was not ready within 150 s: 151 of 151 probes missed, the last 0 round\(s\) answered in full\n[\s\S]*\+150000 ms whoami: internal error; reference = abc$/,
  );
  expect(warn.calls).toHaveLength(151);
});

test("awaitFullRounds: a preview that answers at once passes after exactly the rounds asked for, no warn", async () => {
  const warn = fakeClockAndWarns();
  let calls = 0;
  await awaitFullRounds(
    async () => {
      calls++;
      return [ok, ok, ok];
    },
    { label: "https://pr3-os-preview.example", consecutive: 3 },
  );
  expect({ calls, warns: warn.calls.length }).toEqual({ calls: 3, warns: 0 });
});

test("awaitHostnamePropagation: a hostname live 20 s holds the gate 40 s more, saying so; one live a minute does not wait", async () => {
  fakeClockAndWarns();
  const log = vi.mocked(console.log);
  const started = Date.now();
  await awaitHostnamePropagation("https://pr4-os-preview.example", started - 20_000);
  expect(Date.now() - started).toBe(40_000);
  expect(log.mock.calls.map(([line]) => String(line))).toEqual([
    expect.stringMatching(/went live 20\.0 s ago; waiting 40\.0 s more, until it is 60 s old/),
  ]);
  await awaitHostnamePropagation("https://pr4-os-preview.example", Date.now() - 60_000);
  expect({ waitedMs: Date.now() - started, logs: log.mock.calls.length }).toEqual({
    waitedMs: 40_000,
    logs: 1,
  });
});

const ok = { ok: true as const, ms: 5 };
const miss = { ok: false as const, stage: "whoami", detail: "internal error; reference = abc" };

/** The gate's pauses and its deadline on a fake clock that moves on whenever nothing else is left
 *  to run, and console.warn (the misses) and console.log (the verdict) captured for one test;
 *  `calls` are the warns' first arguments. */
function fakeClockAndWarns() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setTimerTickMode("nextTimerAsync");
  onTestFinished(() => void vi.useRealTimers());
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  return {
    get calls() {
      return warn.mock.calls.map(([first]) => String(first));
    },
  };
}
