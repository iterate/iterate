import { describe, expect, it } from "vitest";
import {
  classifyBoardConnectionChange,
  classifyInputTurn,
  summarizeDrift,
} from "./latency-board.ts";

const turn = (upperBoundMs: number) => ({ sayEndToFirstBoardObservation: { upperBoundMs } });

describe("input turn evidence", () => {
  it("records Satellite turn 59's transcription difference without claiming an extra input turn", () => {
    expect(
      classifyInputTurn({
        transcripts: ["Please say bonobo."],
        speechStarts: 1,
        speechStops: 1,
      }),
    ).toEqual({ oneInputTurn: true, transcriptMatchesPrompt: false });
  });

  it("rejects an extra VAD start even when only the intended transcript completed", () => {
    expect(
      classifyInputTurn({
        transcripts: ["Please say banana."],
        speechStarts: 2,
        speechStops: 1,
      }).oneInputTurn,
    ).toBe(false);
  });
});

describe("board connection continuity", () => {
  const before = { uptimeMs: 1317079, sessionGeneration: 2, connGeneration: 1, batches: 849 };
  const after = { uptimeMs: 1317234, sessionGeneration: 2, connGeneration: 2, batches: 851 };

  it("classifies the recorded HAVPE turn-52 callback renewal separately from a transport restart", () => {
    expect(classifyBoardConnectionChange(before, after)).toBe("delivery-budget-refresh");
  });

  it("rejects a new WebSocket or a reboot even when callback renewal was due", () => {
    expect(classifyBoardConnectionChange(before, { ...after, sessionGeneration: 3 })).toBe(
      "transport-restart",
    );
    expect(classifyBoardConnectionChange(before, { ...after, uptimeMs: 500 })).toBe(
      "transport-restart",
    );
  });

  it("rejects a renewal before the delivery budget or multiple missed generations", () => {
    expect(classifyBoardConnectionChange({ ...before, batches: 20 }, after)).toBe(
      "unexpected-delivery-refresh",
    );
    expect(classifyBoardConnectionChange(before, { ...after, connGeneration: 3 })).toBe(
      "unexpected-delivery-refresh",
    );
  });
});

describe("summarizeDrift", () => {
  it("accepts flat observer bounds but keeps their endpoint uncertainty explicit", () => {
    const summary = summarizeDrift(
      [turn(100), turn(101), turn(99), turn(101), turn(100), turn(99)],
      20,
    );
    expect(summary).toMatchObject({ pass: true, driftMs: -1 });
    expect(summary.endpointUncertainty).toContain("not an acoustic");
  });

  it("rejects increasing last-third observer medians beyond the configured drift", () => {
    expect(
      summarizeDrift([turn(100), turn(105), turn(110), turn(400), turn(410), turn(420)], 100),
    ).toMatchObject({ pass: false, driftMs: 315 });
  });

  it("does not silently pass an unmeasurable two-sample endpoint comparison", () => {
    expect(summarizeDrift([turn(100), turn(200)], 20)).toMatchObject({
      pass: false,
      reason: expect.stringContaining("cannot assess"),
    });
  });
});
