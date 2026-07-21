// @vitest-environment jsdom

import { afterEach, expect, test, vi } from "vitest";
import {
  installVitePreloadRecovery,
  vitePreloadRecoveryContract,
  vitePreloadRecoveryScript,
} from "./vite-preload-recovery.ts";

afterEach(() => {
  document.documentElement.removeAttribute("data-boot-recovery");
  document.body.replaceChildren();
  document.body.removeAttribute("data-hydrated");
});

test("serializes a self-contained recovery program", () => {
  expect(vitePreloadRecoveryScript).toContain("vite:preloadError");
  expect(vitePreloadRecoveryScript).toContain(vitePreloadRecoveryContract.searchParameter);
  expect(vitePreloadRecoveryScript).toContain(vitePreloadRecoveryContract.logPrefix);
  expect(vitePreloadRecoveryScript).toBe(`(${installVitePreloadRecovery.toString()})()`);
});

test("turns the first preload failure into one marked replacement", () => {
  const harness = recoveryHarness("https://os.example.test/projects/example?tab=events");
  installVitePreloadRecovery(harness.runtime);

  const firstFailure = harness.preloadFailure(new Error("Network connection lost."));
  harness.preloadFailure(new Error("another chunk failed"));

  expect(firstFailure.defaultPrevented).toBe(true);
  expect(harness.replace).toHaveBeenCalledOnce();
  expect(harness.replace).toHaveBeenCalledWith(
    "https://os.example.test/projects/example?tab=events&__iterate_vite_preload_recovery=1",
  );
  expect(document.documentElement.dataset.bootRecovery).toBe("reloading");
});

test("clears the marker only after the replacement hydrates", async () => {
  document.body.dataset.hydrated = "false";
  const harness = recoveryHarness(
    "https://os.example.test/projects/example?__iterate_vite_preload_recovery=1&tab=events",
  );
  installVitePreloadRecovery(harness.runtime);

  document.body.dataset.hydrated = "true";
  await vi.waitFor(() => expect(document.documentElement.dataset.bootRecovery).toBe("recovered"));

  expect(harness.replaceState).toHaveBeenCalledWith(
    { preserved: true },
    "",
    "https://os.example.test/projects/example?tab=events",
  );
  expect(harness.warn).toHaveBeenCalledWith("[boot-recovery] recovered after one full-page reload");
});

test("stops with a visible error when the replacement also fails", () => {
  document.body.dataset.hydrated = "false";
  const harness = recoveryHarness(
    "https://os.example.test/projects/example?__iterate_vite_preload_recovery=1",
  );
  installVitePreloadRecovery(harness.runtime);

  harness.preloadFailure(new Error("second connection failure"));

  expect(harness.replace).not.toHaveBeenCalled();
  expect(document.documentElement.dataset.bootRecovery).toBe("failed");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "Automatic recovery stopped to avoid a reload loop.",
  );
  const retry = document.querySelector("button");
  if (!(retry instanceof HTMLButtonElement)) throw new Error("missing retry button");
  retry.click();
  expect(harness.replace).toHaveBeenCalledWith("https://os.example.test/projects/example");
});

function recoveryHarness(initialHref: string) {
  let preloadListener: ((event: Event & { payload?: unknown }) => void) | undefined;
  let href = initialHref;
  const replace = vi.fn((nextHref: string) => {
    href = nextHref;
  });
  const replaceState = vi.fn((_state: unknown, _unused: string, nextHref?: string | URL | null) => {
    if (nextHref) href = nextHref.toString();
  });
  const warn = vi.fn();
  const error = vi.fn();
  const runtime = {
    document,
    MutationObserver,
    URL,
    window: {
      addEventListener(type: string, listener: (event: Event & { payload?: unknown }) => void) {
        if (type === "vite:preloadError") preloadListener = listener;
      },
      console: { error, warn },
      history: { replaceState, state: { preserved: true } },
      location: {
        get href() {
          return href;
        },
        replace,
      },
    },
  };

  return {
    error,
    preloadFailure(payload: unknown) {
      if (!preloadListener) throw new Error("preload listener was not installed");
      const event = Object.assign(new Event("vite:preloadError", { cancelable: true }), {
        payload,
      });
      preloadListener(event);
      return event;
    },
    replace,
    replaceState,
    runtime,
    warn,
  };
}
