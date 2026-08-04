import { describe, expect, test } from "vitest";
import { captureIncidentDiagnostic } from "./incident-diagnostic.ts";

describe("captureIncidentDiagnostic", () => {
  test("returns a durable timeout instead of wedging the whole incident artifact", async () => {
    /*
     * A dead control capability is one of the failures this collector exists
     * to diagnose. If one subordinate RPC can keep the process alive forever,
     * we lose the already-readable provider stream and terminal socket state
     * precisely when they matter most. The operation deliberately never
     * settles to reproduce the physical post-disconnect failure.
     */
    const result = await captureIncidentDiagnostic(() => new Promise(() => undefined), {
      label: "device getDiagnostics",
      timeoutMs: 5,
    });

    expect(result).toEqual({
      error: {
        message: "device getDiagnostics did not settle within 5 ms.",
        name: "IncidentDiagnosticTimeoutError",
      },
      ok: false,
    });
  });

  test("preserves a successful diagnostic value", async () => {
    await expect(
      captureIncidentDiagnostic(async () => ({ closed: true }), {
        label: "pcmMetrics",
        timeoutMs: 50,
      }),
    ).resolves.toEqual({ ok: true, value: { closed: true } });
  });

  test("serializes an ordinary diagnostic rejection", async () => {
    await expect(
      captureIncidentDiagnostic(
        async () => {
          throw new TypeError("offline");
        },
        { label: "device getDiagnostics", timeoutMs: 50 },
      ),
    ).resolves.toEqual({
      error: { message: "offline", name: "TypeError" },
      ok: false,
    });
  });
});
