import { expect, test, vi } from "vitest";

import { retryPlatformFailures } from "./platform-retry.ts";

test("asks again after each delay with a warn, then throws the last failure", async () => {
  using warn = spyOnWarn();
  const answers = ["502", "503", "500", "504"];
  const attempt = vi.fn(async () => {
    throw new Error(answers.shift());
  });

  await expect(
    retryPlatformFailures(attempt, {
      event: "area.platform-failure-retry",
      delaysMs: [0, 1, 2],
      platformFailure,
    }),
  ).rejects.toThrow("504");

  expect(attempt).toHaveBeenCalledTimes(4);
  expect(warn.mock).toMatchObject({
    calls: ["502", "503", "500"].map((status, index) => [
      { event: "area.platform-failure-retry", status, attempt: index + 1, retryInMs: index },
    ]),
  });
});

/** A platform failure here is an Error whose message is a 5xx status. */
function platformFailure(error: unknown) {
  return error instanceof Error && error.message.startsWith("5")
    ? { status: error.message }
    : undefined;
}

function spyOnWarn() {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  return Object.assign(warn, { [Symbol.dispose]: () => warn.mockRestore() });
}
