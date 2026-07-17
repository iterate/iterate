// @vitest-environment jsdom
/** @jsxImportSource @opentui/react */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { TerminalErrorBoundary } from "./terminal-shell.tsx";

type Key = { ctrl?: boolean; name: string };
let keyboardHandler: ((key: Key) => void) | undefined;

vi.mock("@opentui/react", () => ({
  useKeyboard(handler: (key: Key) => void) {
    keyboardHandler = handler;
  },
}));

afterEach(() => {
  keyboardHandler = undefined;
});

describe("TerminalErrorBoundary", () => {
  test("shows the failure and retries the failed query tree on Ctrl+R", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    const onReset = vi.fn();
    let shouldThrow = true;
    const expectedError = vi.spyOn(console, "error").mockImplementation(() => {});

    function RecoverableContent() {
      if (shouldThrow) throw new Error("claims are still catching up");
      return <text>Agent history recovered</text>;
    }

    try {
      await act(async () => {
        root.render(
          <TerminalErrorBoundary
            onReset={() => {
              onReset();
              shouldThrow = false;
            }}
          >
            <RecoverableContent />
          </TerminalErrorBoundary>,
        );
      });

      expect(host.textContent).toContain("Iterate chat failed");
      expect(host.textContent).toContain("claims are still catching up");
      expect(host.textContent).toContain("Ctrl+R to retry");

      await act(async () => keyboardHandler?.({ ctrl: true, name: "r" }));

      expect(onReset).toHaveBeenCalledOnce();
      expect(host.textContent).toContain("Agent history recovered");
    } finally {
      await act(async () => root.unmount());
      expectedError.mockRestore();
    }
  });
});
