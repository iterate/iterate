import { afterEach, describe, expect, it, vi } from "vitest";
import { settleStreamCoreBackgroundWork } from "./stream-durable-object.ts";

afterEach(() => vi.restoreAllMocks());

describe("settleStreamCoreBackgroundWork", () => {
  it("settles a deployment reset as an observed lifecycle interruption", async () => {
    const reset = Object.assign(new Error("Durable Object reset because its code was updated."), {
      durableObjectReset: true,
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      settleStreamCoreBackgroundWork(() => Promise.reject(reset)),
    ).resolves.toBeUndefined();

    expect(info).toHaveBeenCalledWith(
      "stream core background work interrupted by durable object lifecycle",
      { message: reset.message },
    );
    expect(error).not.toHaveBeenCalled();
  });

  it("reports an application failure exactly once while settling the waitUntil promise", async () => {
    const failure = new Error("ancestor append rejected");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      settleStreamCoreBackgroundWork(() => Promise.reject(failure)),
    ).resolves.toBeUndefined();

    expect(info).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith("stream core background work failed", failure);
  });

  it("also observes a synchronous application failure", async () => {
    const failure = new Error("background work did not start");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      settleStreamCoreBackgroundWork(() => {
        throw failure;
      }),
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith("stream core background work failed", failure);
  });
});
