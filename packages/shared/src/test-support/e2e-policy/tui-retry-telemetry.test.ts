import { describe, expect, test } from "vitest";
import { parseTuiRetryTelemetry } from "./tui-retry-telemetry.ts";

describe("parseTuiRetryTelemetry", () => {
  test("reports the final attempt for each retried PTY spec", () => {
    const output = [
      "  ✘  1 stream-tui.spec.ts › Agent chat TUI connects (retry #1) (2s)",
      "  ✔  1 stream-tui.spec.ts › Agent chat TUI connects (retry #2) (3s)",
      "  ✔  2 stream-tui.spec.ts › never retried (1s)",
    ].join("\n");

    expect(parseTuiRetryTelemetry(output)).toEqual({
      retried: [
        {
          fullName: "stream-tui.spec.ts › Agent chat TUI connects",
          retryCount: 2,
          passedAfterRetry: true,
        },
      ],
    });
  });
});
