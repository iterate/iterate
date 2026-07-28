// The browser database compares itself with two fields of the server's core
// reduced state, which crosses `Stream.runtimeState()` as `unknown`. These
// tests pin the parser: it must accept the real CoreProcessorState shape
// (with all its extra server-internal fields), tolerate a not-yet-created
// stream (no `streamId`), and fail loudly on shapes it cannot reconcile
// against.

import { describe, expect, it } from "vitest";
import { CoreProcessorContract } from "../../core-processor-contract.ts";
import { parseBrowserCoreProcessorState } from "./core-processor-state.ts";

describe("parseBrowserCoreProcessorState", () => {
  it("extracts the stream ID and maxOffset from a full core state", () => {
    const coreProcessorState = CoreProcessorContract.stateSchema.parse({
      projectId: "prj_1",
      path: "/agents/bla",
      streamId: "11111111-1111-4111-8111-111111111111",
      createdAt: "2026-07-01T00:00:00.000Z",
      incarnationId: "b3aa1c8e-0000-0000-0000-000000000000",
      maxOffset: 42,
      eventCount: 42,
    });

    expect(parseBrowserCoreProcessorState(coreProcessorState)).toEqual({
      streamId: "11111111-1111-4111-8111-111111111111",
      maxOffset: 42,
    });
  });

  it("treats a stream without a created event as having no stream ID yet", () => {
    // The empty core fold: no created event has been committed, so there is no
    // streamId and maxOffset defaults to 0.
    const emptyState = CoreProcessorContract.stateSchema.parse({});
    expect(parseBrowserCoreProcessorState(emptyState)).toEqual({ maxOffset: 0 });
  });

  it("rejects shapes the browser database cannot compare with", () => {
    expect(() => parseBrowserCoreProcessorState(undefined)).toThrow();
    expect(() => parseBrowserCoreProcessorState(null)).toThrow();
    expect(() => parseBrowserCoreProcessorState({ maxOffset: "42" })).toThrow();
    expect(() =>
      parseBrowserCoreProcessorState({ streamId: "not-a-uuid", maxOffset: 1 }),
    ).toThrow();
    expect(() => parseBrowserCoreProcessorState({ maxOffset: -1 })).toThrow();
  });
});
