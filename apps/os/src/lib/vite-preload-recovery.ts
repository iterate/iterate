// Inline <head> script, installed before Vite's module scripts: a deploy can
// swap hashed assets under an already-served HTML shell, making a preload 404
// into a blank page. Vite's documented answer is to reload on
// vite:preloadError (vite.dev/guide/build#load-error-handling); this adds a
// sessionStorage one-shot guard so a persistently broken deploy renders a
// visible terminal message instead of a reload loop.
//
// Kept as a plain static string on purpose: it ships verbatim as a classic
// script, so no bundler transform can break it (serializing a bundled
// function with toString() could pick up injected helpers). The
// [boot-recovery] console lines are load-bearing — the Playwright harness
// (specs/test-support/test.ts) surfaces them as test annotations so absorbed
// recoveries stay counted rather than silently masking deploy races.
export const vitePreloadRecoveryScript = `(function () {
  var key = "iterate:vite-preload-recovery";
  var prefix = "[boot-recovery]";
  var failed = false;
  var describe = function (payload) {
    return payload && payload.message ? payload.message : String(payload);
  };
  var alreadyAttempted = function () {
    try {
      return sessionStorage.getItem(key) !== null;
    } catch (error) {
      return true; // No storage means no loop guard: never auto-reload.
    }
  };
  window.addEventListener("vite:preloadError", function (event) {
    event.preventDefault();
    if (failed) return;
    if (!alreadyAttempted()) {
      try {
        sessionStorage.setItem(key, "1");
      } catch (error) {}
      console.warn(prefix + " asset preload failed; attempting one full-page reload: " + describe(event.payload));
      location.reload();
      return;
    }
    failed = true;
    console.error(prefix + " replacement boot failed: " + describe(event.payload));
    var render = function () {
      var main = document.createElement("main");
      main.setAttribute("role", "alert");
      main.style.cssText = "max-width:42rem;margin:10vh auto;padding:2rem;font:16px/1.5 system-ui,sans-serif";
      main.innerHTML = "<h1>Iterate could not finish loading</h1><p>A required script failed to load and automatic recovery stopped to avoid a reload loop. Reload the page to try again.</p>";
      var detail = document.createElement("pre");
      detail.style.whiteSpace = "pre-wrap";
      detail.textContent = describe(event.payload);
      main.appendChild(detail);
      document.body.replaceChildren(main);
    };
    if (document.body) render();
    else document.addEventListener("DOMContentLoaded", render, { once: true });
  });
  window.addEventListener("load", function () {
    if (failed) return;
    try {
      if (sessionStorage.getItem(key) === null) return;
      sessionStorage.removeItem(key);
    } catch (error) {
      return;
    }
    console.warn(prefix + " recovered after one full-page reload");
  });
})();`;
