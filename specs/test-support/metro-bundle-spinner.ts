import type { Page, Request } from "@playwright/test";

/**
 * Dev-bundler network waiter: while any Metro `.bundle` request is in
 * flight, hold a `[data-spinner="true"]` marker in the page so middlewright's
 * spinner-waiter treats the compile as visible progress instead of
 * fast-failing the pending action at the tight global actionTimeout
 * (e2e-policy/budgets.ts).
 *
 * Why this exists (and why not a route-level Suspense fallback): Expo web in
 * dev compiles dynamic `import()` chunks on first request — e.g.
 * react-native-enriched-markdown's wasm module the first time a markdown
 * message renders — and during that compile there is no product spinner on
 * screen. expo-router DOES wrap every screen in Suspense, but its fallback
 * is hard-coded (build/views/SuspenseFallback.js — "TODO: Support user's
 * customizing the fallback"), and this app has async routes disabled
 * (app.json `extra.router` has no `asyncRoutes`), so route chunks don't
 * exist — the mid-spec compiles are component-level dynamic imports a route
 * Suspense boundary would never cover anyway. Watching the bundler's own
 * network traffic covers all of them.
 *
 * Dev-spec-only by construction: `.bundle` URLs are Metro's dev-server
 * on-demand compile endpoint; production/exported builds serve plain static
 * `.js` and never match, and the OS web app isn't Metro-served at all — for
 * those pages this is an inert pair of listeners.
 */
export function watchMetroBundles(page: Page) {
  const inFlight = new Set<Request>();
  // One serialized queue: request events interleave, and the marker must
  // reflect the LATEST state — an unordered "add" evaluate landing after the
  // final "remove" would strand a phantom spinner and defeat the
  // spinner-waiter's stuck-UI detection.
  let queue = Promise.resolve();
  const sync = () => {
    const active = inFlight.size > 0;
    queue = queue.then(() =>
      page
        .evaluate((show) => {
          const existing = document.querySelector("[data-metro-bundle-spinner]");
          if (!show) {
            existing?.remove();
            return;
          }
          if (existing !== null) return;
          const marker = document.createElement("div");
          marker.setAttribute("data-metro-bundle-spinner", "");
          marker.setAttribute("data-spinner", "true");
          // Visible on purpose (spinner-waiter checks isVisible()) but
          // unobtrusive: a 6px amber dot in the corner, inert to the page.
          marker.style.cssText =
            "position:fixed;bottom:2px;left:2px;width:6px;height:6px;" +
            "border-radius:3px;background:#fbbf24;z-index:2147483647;pointer-events:none;";
          document.body.append(marker);
        }, active)
        // Navigation mid-evaluate destroys the execution context (taking any
        // marker with it); the next request event converges the state.
        .catch(() => {}),
    );
  };
  const bundleRequest = (request: Request): boolean => {
    try {
      return new URL(request.url()).pathname.endsWith(".bundle");
    } catch {
      return false;
    }
  };
  page.on("request", (request) => {
    if (!bundleRequest(request)) return;
    inFlight.add(request);
    sync();
  });
  const settle = (request: Request) => {
    if (!inFlight.delete(request)) return;
    sync();
  };
  page.on("requestfinished", settle);
  page.on("requestfailed", settle);
}
