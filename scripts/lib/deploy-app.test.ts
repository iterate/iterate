import { afterEach, describe, expect, it, vi } from "vitest";
import { runTimedDeployPhase } from "./deploy-app.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runTimedDeployPhase", () => {
  it("records a successful phase without changing its result", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      runTimedDeployPhase("apps/example", "upload", async () => "deployed"),
    ).resolves.toBe("deployed");

    expect(log).toHaveBeenNthCalledWith(1, "[deploy:apps/example] phase start: upload");
    expect(log.mock.calls.at(-1)?.[0]).toMatch(
      /^\[deploy:apps\/example\] phase finish: upload \(\d+\.\d+s, passed\)$/,
    );
  });

  it("records a failed phase and preserves the original error", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const failure = new Error("control plane refused the upload");

    await expect(
      runTimedDeployPhase("apps/example", "upload", () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(log.mock.calls.at(-1)?.[0]).toMatch(
      /^\[deploy:apps\/example\] phase finish: upload \(\d+\.\d+s, failed\)$/,
    );
  });
});
