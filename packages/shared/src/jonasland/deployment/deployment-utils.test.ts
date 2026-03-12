import { describe, expect, test } from "vitest";
import {
  composeAbortSignal,
  createAbortScope,
  isAbortError,
  throwIfAborted,
} from "./deployment-utils.ts";

describe("deployment-utils abort helpers", () => {
  test("composeAbortSignal returns the original signal when no extra sources exist", () => {
    const controller = new AbortController();

    expect(composeAbortSignal({ signal: controller.signal })).toBe(controller.signal);
  });

  test("createAbortScope aborts the composed signal through the owned controller", () => {
    const scope = createAbortScope();

    scope.abort();

    expect(scope.signal.aborted).toBe(true);
  });

  test("isAbortError recognizes errors thrown by throwIfAborted", () => {
    const controller = new AbortController();
    controller.abort();

    let thrown: unknown;
    try {
      throwIfAborted(controller.signal);
    } catch (error) {
      thrown = error;
    }

    expect(isAbortError(thrown)).toBe(true);
  });
});
