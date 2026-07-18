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

test("serializes the self-contained recovery program for the document head", () => {
  expect(vitePreloadRecoveryScript).toContain("vite:preloadError");
  expect(vitePreloadRecoveryScript).toContain(vitePreloadRecoveryContract.searchParameter);
  expect(vitePreloadRecoveryScript).toContain(vitePreloadRecoveryContract.logPrefix);
  expect(vitePreloadRecoveryScript).toBe(`(${installVitePreloadRecovery.toString()})()`);
});

test("turns the first preload failure into one server-visible replacement navigation", () => {
  const harness = recoveryHarness("https://os.example.test/projects/example/reactivity?tab=events");
  installVitePreloadRecovery(harness.runtime);

  const firstFailure = harness.preloadFailure(new Error("Network connection lost."));
  const secondFailureBeforeNavigation = harness.preloadFailure(new Error("another chunk failed"));

  expect(firstFailure.defaultPrevented).toBe(true);
  expect(secondFailureBeforeNavigation.defaultPrevented).toBe(true);
  expect(harness.replace).toHaveBeenCalledOnce();
  expect(harness.replace).toHaveBeenCalledWith(
    "https://os.example.test/projects/example/reactivity?tab=events&__iterate_vite_preload_recovery=1",
  );
  expect(document.documentElement.dataset.bootRecovery).toBe("reloading");
  expect(harness.warn).toHaveBeenCalledWith(
    "[boot-recovery] asset preload failed; attempting one full-page reload: Network connection lost.",
  );
  expect(harness.error).not.toHaveBeenCalled();
});

test("clears the marker and classifies recovery only after the replacement page hydrates", async () => {
  document.body.dataset.hydrated = "false";
  const harness = recoveryHarness(
    "https://os.example.test/projects/example/reactivity?__iterate_vite_preload_recovery=1&tab=events",
  );
  installVitePreloadRecovery(harness.runtime);

  expect(document.documentElement.dataset.bootRecovery).toBe("recovering");
  expect(harness.replaceState).not.toHaveBeenCalled();

  document.body.dataset.hydrated = "true";
  await vi.waitFor(() => expect(document.documentElement.dataset.bootRecovery).toBe("recovered"));

  expect(harness.replaceState).toHaveBeenCalledWith(
    { preserved: true },
    "",
    "https://os.example.test/projects/example/reactivity?tab=events",
  );
  expect(harness.warn).toHaveBeenCalledWith("[boot-recovery] recovered after one full-page reload");
});

test("renders an explicit terminal error when the replacement boot also loses an asset", () => {
  document.body.dataset.hydrated = "false";
  const harness = recoveryHarness(
    "https://os.example.test/projects/example/reactivity?__iterate_vite_preload_recovery=1",
  );
  installVitePreloadRecovery(harness.runtime);

  const failure = harness.preloadFailure(new Error("second connection failure"));

  expect(failure.defaultPrevented).toBe(true);
  expect(harness.replace).not.toHaveBeenCalled();
  expect(document.documentElement.dataset.bootRecovery).toBe("failed");
  expect(document.body.dataset.hydrated).toBe("true");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "Automatic recovery stopped to avoid a reload loop.",
  );
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "second connection failure",
  );
  expect(harness.error).toHaveBeenCalledWith(
    "[boot-recovery] replacement boot failed: second connection failure",
  );

  const retry = document.querySelector("button");
  if (!(retry instanceof HTMLButtonElement)) throw new Error("missing explicit retry button");
  retry.click();
  expect(harness.replace).toHaveBeenCalledWith(
    "https://os.example.test/projects/example/reactivity",
  );
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
