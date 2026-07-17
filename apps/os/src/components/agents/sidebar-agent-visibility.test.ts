import { expect, test } from "vitest";
import { sidebarAgentRowsVisible } from "./sidebar-agent-visibility.ts";

test.each([
  [{ isMobile: false, openMobile: false, state: "collapsed" as const }, false],
  [{ isMobile: false, openMobile: false, state: "expanded" as const }, true],
  [{ isMobile: true, openMobile: false, state: "expanded" as const }, false],
  [{ isMobile: true, openMobile: true, state: "collapsed" as const }, true],
])("mounts rich agent rows only on a visible expanded sidebar", (input, expected) => {
  expect(sidebarAgentRowsVisible(input)).toBe(expected);
});
