import { buildFailureMessageFromError } from "./artifact-store.ts";
import {
  OVERLAY_OPT_OUT_HEADER,
  WORKER_BUILD_FAILED_HEADER,
  WORKER_SERVE_HEADER,
  WorkerServeInfo,
} from "./worker-serve-info.ts";

/**
 * The presentation half of the serve-side status surface (contract:
 * worker-serve-info.ts): the platform chrome browsers see around dynamic
 * worker builds.
 *
 * - The @iterate overlay — injected by project ingress into HTML documents
 *   (HTMLRewriter, before `</body>`): a floating iterate mark that surfaces
 *   build state in the corner of every project page, and — while a rebuild
 *   runs — polls the serve header until the fresh build lands, then reloads.
 * - The building page body (served by workerBuildingResponse in
 *   worker-fetch-dispatch.ts) and the build-failed page — the two terminal
 *   states of the lane: nothing built yet to fall back on, so a page stands
 *   in for the worker. Both poll their own URL and self-heal.
 */

/** The iterate mark — the letter i from the product logo. */
const ITERATE_MARK_SVG = `<svg viewBox="0 0 500 500" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="iterate"><rect width="500" height="500" fill="black" rx="100"/><path d="M264.649 170.149H289.821L286.092 186.904L276.303 233.444L270.709 259.971L263.717 293.015L258.124 320.008L251.131 352.586L249.267 364.687V371.668L249.733 372.133H253.462L259.522 369.806L266.048 365.617L275.371 357.24L282.829 349.328L286.558 345.14L288.888 346.071L294.948 350.725L308 360.498L307.068 362.36L303.339 367.944L296.813 376.322L291.685 382.837L286.558 388.422L282.363 393.076L275.837 399.592L272.108 402.849L267.446 406.573L262.785 409.83L256.725 413.554L247.869 417.742L238.08 420.535L231.554 421H224.096L216.637 420.069L211.51 418.673L206.382 416.811L201.255 413.088L196.594 408.434L192.865 400.988L191.466 394.938L191 389.818V383.768L193.797 365.152L199.857 335.832L207.315 301.392L224.096 223.205L225.028 216.224V206.916L224.562 205.054L222.231 204.123L219.434 203.193L206.382 203.658L196.127 204.589H193.331V178.526L194.263 175.734L258.59 170.615L264.649 170.149Z" fill="white"/><path d="M264.649 78H268.844L275.836 78.9308L282.362 80.7924L287.49 83.5848L292.151 87.7734L295.414 92.8928L297.278 96.616L299.143 105.924L299.609 113.836L299.143 118.49L298.677 122.213L296.812 128.729L293.549 134.779L290.286 138.502L286.091 141.76L282.362 143.621L278.167 145.018L274.438 145.948L267.912 146.414H260.92L254.394 145.483L249.267 144.087L244.139 141.294L239.944 138.037L236.681 133.383L233.884 127.332L232.486 121.282L232.02 117.559V108.716L232.952 101.735L234.816 95.6852L237.613 90.1004L240.41 86.3772L246.936 82.1886L252.529 79.8616L259.522 78.4654L264.649 78Z" fill="white"/></svg>`;

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Standard shell for the platform's stand-in pages (building / build
 * failed) — dark, centered, the mark on top. */
function servePageHtml(input: { body: string; head?: string; title: string }): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(input.title)}</title>
    ${input.head ?? ""}
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0a0a0a; color: #fafafa; font: 14px/1.6 ui-sans-serif, system-ui, sans-serif; }
      main { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 24px; text-align: center; max-width: 620px; }
      main > svg, main > div > svg { width: 56px; height: 56px; }
      h1 { font-size: 16px; font-weight: 600; margin: 4px 0 0; }
      p { margin: 0; color: #a3a3a3; }
      pre { margin: 8px 0 0; padding: 10px 12px; background: #171717; border: 1px solid #262626; border-radius: 8px; color: #fca5a5; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; text-align: left; white-space: pre-wrap; word-break: break-word; max-width: 100%; max-height: 40vh; overflow: auto; }
      .pulse { animation: pulse 1.6s ease-in-out infinite; }
      @keyframes pulse { 50% { opacity: 0.45; } }
    </style>
  </head>
  <body>
    ${input.body}
  </body>
</html>`;
}

/** The stand-in pages' shared self-heal loop: poll this URL until the marker
 * header clears, then reload. */
function reloadWhenHeaderClearsScript(headerName: string, intervalMs: number): string {
  return `const poll = async () => {
        try {
          const res = await fetch(location.href, { cache: "no-store" });
          if (!res.headers.get(${JSON.stringify(headerName)})) { location.reload(); return; }
        } catch {}
        setTimeout(poll, ${intervalMs});
      };
      setTimeout(poll, ${intervalMs});`;
}

/**
 * The building page body: nothing has ever built for this worker, so a page
 * stands in — it polls its own URL and reloads the moment the building marker
 * disappears (no-JS clients fall back to a meta refresh). Served with the
 * 503/WORKER_BUILDING_HEADER contract by workerBuildingResponse, which also
 * owns that header's name — passed in here to keep the dependency one-way.
 */
export function workerBuildingPageHtml(buildingHeader: string): string {
  return servePageHtml({
    body: `<main data-spinner="true">
      <div class="pulse">${ITERATE_MARK_SVG}</div>
      <h1>Building your worker</h1>
      <p>First build of this version — the page reloads when it's ready.</p>
      <p id="elapsed"></p>
    </main>
    <script>
      const started = Date.now();
      const elapsed = document.getElementById("elapsed");
      setInterval(() => { elapsed.textContent = Math.round((Date.now() - started) / 1000) + "s"; }, 1000);
      ${reloadWhenHeaderClearsScript(buildingHeader, 1_500)}
    </script>`,
    head: `<noscript><meta http-equiv="refresh" content="3" /></noscript>`,
    title: "Building…",
  });
}

/**
 * The terminal case: the build failed and there is no previous good build to
 * fall back on. Shows the builder's error and polls its own URL — a fixed
 * commit is a new build key, so the page self-heals the same way the building
 * page does.
 */
export function workerBuildFailedResponse(error: unknown): Response {
  return new Response(
    servePageHtml({
      body: `<main>
        ${ITERATE_MARK_SVG}
        <h1>Worker build failed</h1>
        <p>Fix the worker source and this page picks it up automatically.</p>
        <pre>${escapeHtml(buildFailureMessageFromError(error))}</pre>
      </main>
      <script>
        ${reloadWhenHeaderClearsScript(WORKER_BUILD_FAILED_HEADER, 3_000)}
      </script>`,
      title: "Worker build failed",
    }),
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        [WORKER_BUILD_FAILED_HEADER]: "1",
        // Platform chrome, not a worker page — the overlay stays out.
        [OVERLAY_OPT_OUT_HEADER]: "1",
      },
      status: 500,
    },
  );
}

/**
 * Whether (and with what) to inject the overlay into a project-lane response:
 * an HTML document carrying platform serve info, not a socket, not opted out,
 * and nothing we would corrupt by transforming (own CSP, pre-encoded body).
 * Exported for unit tests — the HTMLRewriter call itself is proven in e2e
 * (workerd-only API).
 */
export function workerOverlayDecision(
  request: Request,
  response: Response,
): WorkerServeInfo | null {
  if (response.status === 101 || response.webSocket || response.body === null) return null;
  const raw = response.headers.get(WORKER_SERVE_HEADER);
  if (raw === null) return null;
  if (!response.headers.get("content-type")?.includes("text/html")) return null;
  if (response.headers.has(OVERLAY_OPT_OUT_HEADER)) return null;
  // A page with its own CSP likely forbids inline scripts — injecting would
  // only produce console errors, never a widget. A pre-encoded body (a worker
  // returning bytes it compressed itself) cannot be parsed, let alone
  // transformed.
  if (response.headers.has("content-security-policy")) return null;
  if (response.headers.has("content-encoding")) return null;
  // Subresource fetches (XHR returning HTML fragments) don't need chrome;
  // absent sec-fetch-dest (curl, old clients) counts as a document.
  const dest = request.headers.get("sec-fetch-dest");
  if (dest !== null && dest !== "document") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const info = WorkerServeInfo.safeParse(parsed);
  return info.success ? info.data : null;
}

/**
 * The injected fragment: one inline script that mounts the floating iterate
 * mark in a shadow root (page CSS cannot reach in) with a status popover.
 * While a rebuild runs it polls the serve header and reloads on fresh.
 *
 * `info` MUST be schema-validated (workerOverlayDecision) — `state` derives
 * from the `reason` enum and reaches the widget's innerHTML as an attribute.
 */
export function workerOverlayHtml(info: WorkerServeInfo): string {
  // U+003C escaping keeps any "</script>" (or "<!--") inside failure messages
  // inert; U+2028/2029 stay out of the source for pre-ES2019 parsers.
  const infoJson = JSON.stringify(info)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return `<script>(() => {
  if (window.__iterateWorkerOverlay) return;
  window.__iterateWorkerOverlay = true;
  const info = ${infoJson};
  const state = info.status === "fresh" ? "fresh" : info.reason;
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;bottom:16px;right:16px;z-index:2147483647";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = \`<style>
    :host { all: initial; }
    #badge { display: block; position: relative; width: 34px; height: 34px; padding: 0; border: 0; background: none; cursor: pointer; opacity: .55; transition: opacity .15s; }
    #badge svg { width: 100%; height: 100%; border-radius: 9px; box-shadow: 0 2px 10px rgba(0,0,0,.35); }
    #badge:hover, .building #badge, .build-failed #badge { opacity: 1; }
    #dot { display: none; position: absolute; top: -3px; right: -3px; width: 9px; height: 9px; border-radius: 50%; border: 2px solid #fff; }
    .building #dot { display: block; background: #f59e0b; animation: pulse 1.2s infinite; }
    .build-failed #dot { display: block; background: #ef4444; }
    @keyframes pulse { 50% { opacity: .35; } }
    #panel { position: absolute; bottom: 42px; right: 0; width: 320px; padding: 12px 14px; background: #0a0a0a; color: #fafafa; border: 1px solid #262626; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.45); font: 12px/1.5 ui-sans-serif, system-ui, sans-serif; }
    #panel header { display: flex; justify-content: space-between; color: #a3a3a3; margin-bottom: 4px; }
    #status { color: #fafafa; }
    #error { display: none; margin: 8px 0 0; padding: 8px 10px; background: #171717; border-radius: 6px; color: #fca5a5; font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-word; max-height: 180px; overflow: auto; }
    .build-failed #error { display: block; }
  </style>
  <div id="widget" class="\${state}">
    <div id="panel" hidden>
      <header><span>iterate worker</span><span id="commit"></span></header>
      <div id="status"></div>
      <pre id="error"></pre>
    </div>
    <button id="badge" aria-label="iterate worker status">${ITERATE_MARK_SVG}<span id="dot"></span></button>
  </div>\`;
  const short = (oid) => (oid ? oid.slice(0, 7) : "");
  root.getElementById("commit").textContent = short(info.commitOid);
  root.getElementById("status").textContent =
    state === "fresh" ? "Live — serving the latest build."
    : state === "building" ? "Rebuilding — serving the previous build until the new one lands."
    : "Build failed — serving the previous build. Latest commit: " + (short(info.failure && info.failure.commitOid) || "unknown") + ".";
  if (info.failure) root.getElementById("error").textContent = info.failure.message;
  const panel = root.getElementById("panel");
  root.getElementById("badge").addEventListener("click", () => { panel.hidden = !panel.hidden; });
  document.body.appendChild(host);
  if (state !== "building") return;
  let polls = 0;
  const poll = async () => {
    try {
      const res = await fetch(location.href, { cache: "no-store" });
      const raw = res.headers.get(${JSON.stringify(WORKER_SERVE_HEADER)});
      if (raw) {
        const next = JSON.parse(raw);
        if (next.status === "fresh" || next.reason !== info.reason) { location.reload(); return; }
      }
    } catch {}
    if (polls++ < 100) setTimeout(poll, 2500);
  };
  setTimeout(poll, 2500);
})();</script>`;
}

/**
 * Ingress's one call: dress a project-worker response in the platform's
 * overlay. HTML documents get the widget appended before </body> via
 * HTMLRewriter (streaming — bytes flow while the parser looks for the body
 * end tag); everything else passes through untouched.
 */
export function applyProjectWorkerOverlay(request: Request, response: Response): Response {
  const info = workerOverlayDecision(request, response);
  if (info === null) return response;
  const transformed = new HTMLRewriter()
    .on("body", {
      element(element) {
        element.append(workerOverlayHtml(info), { html: true });
      },
    })
    .transform(response);
  const out = new Response(transformed.body, transformed);
  // The transform changes byte length, and fetch already decompressed the
  // upstream body — a copied length header would lie about this body.
  out.headers.delete("content-length");
  return out;
}
