import { describe, expect, test } from "vitest";
import {
  focusStreamTuiComposer,
  focusStreamTuiFeed,
  focusStreamTuiHeader,
  initialStreamTuiNavigationState,
  setStreamTuiView,
} from "./navigation-state.ts";

describe("stream TUI navigation state", () => {
  test("switching views returns focus to the composer", () => {
    const feedFocused = focusStreamTuiFeed(initialStreamTuiNavigationState);

    expect(setStreamTuiView(feedFocused, "state")).toEqual({
      view: "state",
      focus: "composer",
    });
  });

  test("feed and composer focus are explicit state transitions", () => {
    const feedFocused = focusStreamTuiFeed(initialStreamTuiNavigationState);

    expect(feedFocused.focus).toBe("feed");
    expect(focusStreamTuiComposer(feedFocused).focus).toBe("composer");
    expect(focusStreamTuiHeader(feedFocused).focus).toBe("header");
  });
});
