// @vitest-environment jsdom

import { afterEach, expect, test } from "vitest";
import { vitePreloadRecoveryScript } from "./vite-preload-recovery.ts";

const GUARD_KEY = "iterate:vite-preload-recovery";

// The shipped artifact IS this string: executing it verbatim from an inline
// script tag is exactly what the browser does with the <head> tag __root.tsx
// renders. (jsdom scripts log to their own realm's console, so the tests
// assert observable effects — storage, DOM — not console calls.)
const install = () => {
  const script = document.createElement("script");
  script.textContent = vitePreloadRecoveryScript;
  document.head.append(script);
  script.remove();
};

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
});

test("logs on the [boot-recovery] channel the Playwright harness annotates", () => {
  // specs/test-support/test.ts surfaces console lines with this prefix as
  // test annotations — that visibility is what keeps absorbed recoveries
  // counted instead of silently masking deploy races.
  expect(vitePreloadRecoveryScript).toContain('"[boot-recovery]"');
  expect(vitePreloadRecoveryScript).toContain("recovered after one full-page reload");
});

test("reloads once on the first failure, then stops with a visible error", () => {
  install();

  const first = preloadFailure("Network connection lost.");
  expect(first.defaultPrevented).toBe(true);
  expect(sessionStorage.getItem(GUARD_KEY)).toBe("1");

  // In the browser location.reload() unloads the page here; a second event
  // in the same session means the replacement load is broken too.
  preloadFailure("still failing after reload");
  const alert = document.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("reload loop");
  expect(alert?.textContent).toContain("still failing after reload");
});

test("a clean load clears the guard so a later deploy gets its own reload", () => {
  sessionStorage.setItem(GUARD_KEY, "1");
  install();

  window.dispatchEvent(new Event("load"));

  expect(sessionStorage.getItem(GUARD_KEY)).toBeNull();
});
