// The browser mirror reconciles against two fields of the server's core
// reduced state, which crosses `Stream.runtimeState()` as `unknown`. These
// tests pin the parser: it must accept the real CoreProcessorState shape
// (with all its extra server-internal fields), tolerate a not-yet-created
// stream (no `createdAt`), and fail loudly on shapes it cannot reconcile
// against.

import { describe, expect, it } from "vitest";
import { CoreProcessorContract } from "../../core-processor-contract.ts";
import { parseBrowserCoreProcessorState } from "./core-processor-state.ts";

describe("parseBrowserCoreProcessorState", () => {
  it("extracts incarnation identity and maxOffset from a full core state", () => {
    const coreProcessorState = CoreProcessorContract.stateSchema.parse({
      projectId: "prj_1",
      path: "/agents/bla",
      createdAt: "2026-07-01T00:00:00.000Z",
      incarnationId: "b3aa1c8e-0000-0000-0000-000000000000",
      maxOffset: 42,
      eventCount: 42,
    });

    expect(parseBrowserCoreProcessorState(coreProcessorState)).toEqual({
      createdAt: "2026-07-01T00:00:00.000Z",
      maxOffset: 42,
    });
  });

  it("treats a stream without a created event as having no incarnation yet", () => {
    // The empty core fold: no created event has been committed, so there is no
    // createdAt and maxOffset defaults to 0.
    const emptyState = CoreProcessorContract.stateSchema.parse({});
    expect(parseBrowserCoreProcessorState(emptyState)).toEqual({ maxOffset: 0 });
  });

  it("rejects shapes the mirror cannot reconcile against", () => {
    expect(() => parseBrowserCoreProcessorState(undefined)).toThrow();
    expect(() => parseBrowserCoreProcessorState(null)).toThrow();
    expect(() => parseBrowserCoreProcessorState({ maxOffset: "42" })).toThrow();
    expect(() => parseBrowserCoreProcessorState({ createdAt: 123, maxOffset: 1 })).toThrow();
    expect(() => parseBrowserCoreProcessorState({ maxOffset: -1 })).toThrow();
  });
});
