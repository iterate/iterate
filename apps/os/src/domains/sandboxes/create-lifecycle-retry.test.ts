import { describe, expect, it, vi } from "vitest";
import {
  createSandboxWithLifecycleRetry,
  SANDBOX_CREATE_LIFECYCLE_MAX_ATTEMPTS,
} from "./create-lifecycle-retry.ts";

function lifecycleError(message: string): Error {
  return Object.assign(new Error(message), { durableObjectReset: true });
}

describe("createSandboxWithLifecycleRetry", () => {
  it("uses the strict create once and does not enter the resume path on success", async () => {
    const create = vi.fn(async () => "created");
    const resume = vi.fn(async () => "resumed");

    await expect(createSandboxWithLifecycleRetry({ create, resume })).resolves.toBe("created");
    expect(create).toHaveBeenCalledOnce();
    expect(resume).not.toHaveBeenCalled();
  });

  it("resumes after lifecycle resets and obtains a fresh result", async () => {
    const create = vi.fn(async () => {
      throw lifecycleError("code updated");
    });
    const resume = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(Object.assign(new Error("overloaded"), { overloaded: true }))
      .mockResolvedValueOnce("healed");
    const onRetry = vi.fn();

    await expect(createSandboxWithLifecycleRetry({ create, onRetry, resume })).resolves.toBe(
      "healed",
    );
    expect(create).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenLastCalledWith({
      attempt: 2,
      error: expect.objectContaining({ message: "overloaded" }),
      maxAttempts: SANDBOX_CREATE_LIFECYCLE_MAX_ATTEMPTS,
    });
  });

  it("never retries application errors", async () => {
    const applicationError = new Error("sandbox already exists");
    const create = vi.fn(async () => {
      throw applicationError;
    });
    const resume = vi.fn(async () => "unexpected");

    await expect(createSandboxWithLifecycleRetry({ create, resume })).rejects.toBe(
      applicationError,
    );
    expect(create).toHaveBeenCalledOnce();
    expect(resume).not.toHaveBeenCalled();
  });

  it("stops after the bounded number of lifecycle attempts", async () => {
    const finalError = lifecycleError("third reset");
    const create = vi.fn(async () => {
      throw lifecycleError("first reset");
    });
    const resume = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(lifecycleError("second reset"))
      .mockRejectedValueOnce(finalError);

    await expect(createSandboxWithLifecycleRetry({ create, resume })).rejects.toBe(finalError);
    expect(create).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledTimes(SANDBOX_CREATE_LIFECYCLE_MAX_ATTEMPTS - 1);
  });
});
