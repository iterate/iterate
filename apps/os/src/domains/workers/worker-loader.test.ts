import { describe, expect, it } from "vitest";
import { isInvalidWorkerLoaderCloneError } from "./worker-loader.ts";

describe("Worker Loader infrastructure errors", () => {
  it("recognizes only Cloudflare's invalid retained-clone failure", () => {
    expect(
      isInvalidWorkerLoaderCloneError(
        new Error("Unable to deserialize cloned data due to invalid or unsupported version."),
      ),
    ).toBe(true);
    expect(isInvalidWorkerLoaderCloneError(new Error("processEvent rejected payload"))).toBe(false);
    expect(isInvalidWorkerLoaderCloneError({ message: "Unable to serialize cloned data." })).toBe(
      false,
    );
  });
});
