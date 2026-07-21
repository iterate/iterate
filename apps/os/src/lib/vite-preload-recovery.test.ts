// @vitest-environment jsdom

import { afterEach, expect, test, vi } from "vitest";
import { vitePreloadRecoveryScript } from "./vite-preload-recovery.ts";

const GUARD_KEY = "iterate:vite-preload-recovery";

// The shipped artifact IS this string: evaluating it verbatim as a classic
// script is exactly what the browser does with the inline <head> tag.
const install = () => new Function(vitePreloadRecoveryScript)();

function preloadFailure(message: string) {
  const event = Object.assign(new Event("vite:preloadError", { cancelable: true }), {
    payload: new Error(message),
  });
  window.dispatchEvent(event);
  return event;
}

afterEach(() => {
  sessionStorage.clear();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

test("reloads once on the first failure, then stops with a visible error", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  install();

  const first = preloadFailure("Network connection lost.");
  expect(first.defaultPrevented).toBe(true);
  expect(sessionStorage.getItem(GUARD_KEY)).toBe("1");
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("[boot-recovery]"));

  // In the browser location.reload() unloads the page here; a second event
  // in the same session means the replacement load is broken too.
  preloadFailure("still failing after reload");
  expect(error).toHaveBeenCalledWith(expect.stringContaining("[boot-recovery]"));
  const alert = document.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("reload loop");
  expect(alert?.textContent).toContain("still failing after reload");
});

test("a clean load clears the guard and reports the recovery", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  sessionStorage.setItem(GUARD_KEY, "1");
  install();

  window.dispatchEvent(new Event("load"));

  expect(sessionStorage.getItem(GUARD_KEY)).toBeNull();
  expect(warn).toHaveBeenCalledWith("[boot-recovery] recovered after one full-page reload");
});
