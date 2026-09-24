import { expect, onTestFinished, test, vi } from "vitest";
import { watchSignInStep } from "./sign-in-watch.ts";

test("a sign-in step still waiting after five seconds is named in a line while it waits; a quick one logs nothing", async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => {
    vi.useRealTimers();
    warn.mockRestore();
  });
  let finish!: (value: string) => void;
  const stalled = watchSignInStep("code-exchange", new Promise<string>((r) => (finish = r)));
  await vi.advanceTimersByTimeAsync(4_999);
  expect(warn).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(warn).toHaveBeenCalledWith({
    event: "issuer.sign-in-slow",
    step: "code-exchange",
    waitedMs: 5_000,
  });
  finish("done");
  expect(await stalled).toBe("done");

  warn.mockClear();
  expect(await watchSignInStep("ensure-user", Promise.resolve(1))).toBe(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(warn).not.toHaveBeenCalled();
});
