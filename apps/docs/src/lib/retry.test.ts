import { describe, expect, test, vi } from "vitest";
import { withRetries } from "./retry.ts";

describe("withRetries", () => {
  test("succeeds on a later attempt, sleeping the given delays between tries", async () => {
    let calls = 0;
    const sleep = vi.fn(async (_ms: number) => {});
    const result = await withRetries(
      async () => {
        calls++;
        if (calls < 3) throw new Error(`not yet ${calls}`);
        return "done";
      },
      { attempts: 3, delayMs: (attempt) => attempt * 1000, sleep },
    );
    expect(result).toBe("done");
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000]);
  });

  test("throws the last error once the attempts are spent", async () => {
    let calls = 0;
    await expect(
      withRetries(
        async () => {
          calls++;
          throw new Error(`fail ${calls}`);
        },
        { attempts: 2, delayMs: () => 0, sleep: async () => {} },
      ),
    ).rejects.toThrow("fail 2");
  });

  test("does not retry an error the caller says is final", async () => {
    const run = vi.fn(async () => {
      throw new Error("does not exist");
    });
    await expect(
      withRetries(run, {
        attempts: 3,
        delayMs: () => 0,
        shouldRetry: (error) => !(error instanceof Error && /exist/.test(error.message)),
        sleep: async () => {},
      }),
    ).rejects.toThrow("does not exist");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
