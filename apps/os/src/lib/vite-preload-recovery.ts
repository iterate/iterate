const recoverySearchParameter = "__iterate_vite_preload_recovery";
const recoveryLogPrefix = "[boot-recovery]";

type RecoveryWindow = {
  addEventListener(type: string, listener: (event: Event & { payload?: unknown }) => void): void;
  console: Pick<Console, "error" | "warn">;
  history: Pick<History, "replaceState" | "state">;
  location: Pick<Location, "href" | "replace">;
};

type RecoveryDocument = Pick<
  Document,
  "addEventListener" | "body" | "createElement" | "documentElement"
>;

type RecoveryRuntime = {
  document: RecoveryDocument;
  MutationObserver: typeof MutationObserver;
  URL: typeof URL;
  window: RecoveryWindow;
};

/**
 * Install before Vite's module scripts execute. Vite emits a cancelable
 * `vite:preloadError` when a dynamic import or one of its preloads cannot be
 * fetched. The browser cannot retry that import in-place, so reload the whole
 * document once with a server-visible marker. If the replacement boot also
 * fails, stop and render an explicit error instead of entering a reload loop.
 *
 * The optional runtime exists only so the exact browser program can be unit
 * tested. Keep this function self-contained: its production form is serialized
 * with `toString()` and placed inline in the document head.
 */
export function installVitePreloadRecovery(runtime?: RecoveryRuntime) {
  const browserWindow = runtime?.window ?? (window as unknown as RecoveryWindow);
  const browserDocument = runtime?.document ?? (document as unknown as RecoveryDocument);
  const BrowserMutationObserver = runtime?.MutationObserver ?? MutationObserver;
  const BrowserURL = runtime?.URL ?? URL;
  const marker = "__iterate_vite_preload_recovery";
  const logPrefix = "[boot-recovery]";
  let arrivedFromRecovery = new BrowserURL(browserWindow.location.href).searchParams.has(marker);
  let recoveryFailed = false;
  let recoveryObserver: MutationObserver | null = null;
  let replacementStarted = false;

  const errorMessage = (error: unknown) => {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    return "The application bundle could not be loaded.";
  };

  const withoutMarker = () => {
    const url = new BrowserURL(browserWindow.location.href);
    url.searchParams.delete(marker);
    return url;
  };

  const renderFatalError = (error: unknown) => {
    recoveryFailed = true;
    recoveryObserver?.disconnect();
    const render = () => {
      const body = browserDocument.body;
      if (!body) return;

      browserDocument.documentElement.dataset.bootRecovery = "failed";
      body.dataset.hydrated = "true";
      const main = browserDocument.createElement("main");
      main.setAttribute("role", "alert");
      main.style.cssText =
        "max-width:42rem;margin:10vh auto;padding:2rem;font:16px/1.5 system-ui,sans-serif";

      const heading = browserDocument.createElement("h1");
      heading.textContent = "Iterate could not finish loading";
      const explanation = browserDocument.createElement("p");
      explanation.textContent =
        "A browser asset failed twice. Automatic recovery stopped to avoid a reload loop.";
      const detail = browserDocument.createElement("pre");
      detail.textContent = errorMessage(error);
      detail.style.whiteSpace = "pre-wrap";
      const retry = browserDocument.createElement("button");
      retry.type = "button";
      retry.textContent = "Try loading again";
      retry.addEventListener("click", () => browserWindow.location.replace(withoutMarker().href));
      main.appendChild(heading);
      main.appendChild(explanation);
      main.appendChild(detail);
      main.appendChild(retry);
      body.replaceChildren(main);
    };

    if (browserDocument.body) render();
    else browserDocument.addEventListener("DOMContentLoaded", render, { once: true });
  };

  const finishRecoveryAfterHydration = () => {
    const body = browserDocument.body;
    if (recoveryFailed || !arrivedFromRecovery || body?.dataset.hydrated !== "true") return false;

    const cleanUrl = withoutMarker();
    browserWindow.history.replaceState(browserWindow.history.state, "", cleanUrl.href);
    browserDocument.documentElement.dataset.bootRecovery = "recovered";
    arrivedFromRecovery = false;
    browserWindow.console.warn(`${logPrefix} recovered after one full-page reload`);
    return true;
  };

  if (arrivedFromRecovery) {
    browserDocument.documentElement.dataset.bootRecovery = "recovering";
    const observer = new BrowserMutationObserver(() => {
      if (finishRecoveryAfterHydration()) observer.disconnect();
    });
    recoveryObserver = observer;
    observer.observe(browserDocument.documentElement, {
      attributeFilter: ["data-hydrated"],
      attributes: true,
      subtree: true,
    });
    browserDocument.addEventListener(
      "DOMContentLoaded",
      () => {
        if (finishRecoveryAfterHydration()) observer.disconnect();
      },
      { once: true },
    );
  }

  browserWindow.addEventListener("vite:preloadError", (event) => {
    event.preventDefault();
    if (replacementStarted) return;

    if (arrivedFromRecovery) {
      const message = errorMessage(event.payload);
      browserWindow.console.error(`${logPrefix} replacement boot failed: ${message}`);
      renderFatalError(event.payload);
      return;
    }

    replacementStarted = true;
    const replacementUrl = new BrowserURL(browserWindow.location.href);
    replacementUrl.searchParams.set(marker, "1");
    browserDocument.documentElement.dataset.bootRecovery = "reloading";
    browserWindow.console.warn(
      `${logPrefix} asset preload failed; attempting one full-page reload: ${errorMessage(event.payload)}`,
    );
    browserWindow.location.replace(replacementUrl.href);
  });
}

export const vitePreloadRecoveryScript = `(${installVitePreloadRecovery.toString()})()`;

// Exported for assertions that the inline program keeps its server-visible
// marker and log classification stable.
export const vitePreloadRecoveryContract = {
  logPrefix: recoveryLogPrefix,
  searchParameter: recoverySearchParameter,
} as const;
