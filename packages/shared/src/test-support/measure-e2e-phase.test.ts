import { expect, test, vi } from "vitest";
import { annotateE2ePhase, measureE2ePhase } from "./measure-e2e-phase.ts";

test("records explicit observed or derived phases", async () => {
  const annotate = vi.fn().mockResolvedValue(undefined);

  await annotateE2ePhase(annotate, {
    name: "remote start spread",
    category: "remote-observation",
    durationMs: 123,
    startedAt: new Date("2026-07-21T10:00:00.000Z"),
  });

  expect(annotate).toHaveBeenCalledWith(
    JSON.stringify({
      name: "remote start spread",
      category: "remote-observation",
      durationMs: 123,
      startedAt: "2026-07-21T10:00:00.000Z",
    }),
    "e2e-phase",
  );
});

test("preserves the measured operation failure when phase annotation also fails", async () => {
  const operationError = new Error("operation failed");
  const annotate = vi.fn().mockRejectedValue(new Error("annotation failed"));
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  await expect(
    measureE2ePhase(annotate, "test phase", "operation", async () => {
      throw operationError;
    }),
  ).rejects.toBe(operationError);
  expect(annotate).toHaveBeenCalledOnce();
  expect(consoleError).toHaveBeenCalledOnce();
});

test("fails a successful operation when its required phase annotation cannot be recorded", async () => {
  const annotationError = new Error("annotation failed");

  await expect(
    measureE2ePhase(
      vi.fn().mockRejectedValue(annotationError),
      "test phase",
      "operation",
      async () => "result",
    ),
  ).rejects.toBe(annotationError);
});
