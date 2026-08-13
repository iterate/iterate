import { buildFailureMessageFromError } from "./artifact-store.ts";
import {
  OVERLAY_OPT_OUT_HEADER,
  WORKER_BUILD_FAILED_HEADER,
  WORKER_SERVE_ERROR_HEADER,
  WORKER_SERVE_HEADER,
} from "./worker-serve-info.ts";

/**
 * The presentation half of the serve-side status surface (contract:
 * worker-serve-info.ts): the platform chrome browsers see around dynamic
 * worker builds.
 *
 * ONE visual language — the @iterate mark in the bottom-right corner. On a
 * served HTML document, ingress injects it (HTMLRewriter, before `</body>`)
 * in its `live` state. When there is nothing to serve — first build running,
 * build failed, platform serve error — the stand-in page is a bare white
 * document mounting the SAME overlay component in the matching state:
 * a spinner ring tracing the mark's border while something is happening,
 * a red ring for errors, a tooltip on hover, details in a click-open menu.
 * The same streaming transform supplies an inverted iterate favicon only
 * when the user-space document did not provide a rel=icon link itself.
 */

/** The iterate mark's canonical path geometry. */
const ITERATE_I_PATH =
  "M264.649 170.149H289.821L286.092 186.904L276.303 233.444L270.709 259.971L263.717 293.015L258.124 320.008L251.131 352.586L249.267 364.687V371.668L249.733 372.133H253.462L259.522 369.806L266.048 365.617L275.371 357.24L282.829 349.328L286.558 345.14L288.888 346.071L294.948 350.725L308 360.498L307.068 362.36L303.339 367.944L296.813 376.322L291.685 382.837L286.558 388.422L282.363 393.076L275.837 399.592L272.108 402.849L267.446 406.573L262.785 409.83L256.725 413.554L247.869 417.742L238.08 420.535L231.554 421H224.096L216.637 420.069L211.51 418.673L206.382 416.811L201.255 413.088L196.594 408.434L192.865 400.988L191.466 394.938L191 389.818V383.768L193.797 365.152L199.857 335.832L207.315 301.392L224.096 223.205L225.028 216.224V206.916L224.562 205.054L222.231 204.123L219.434 203.193L206.382 203.658L196.127 204.589H193.331V178.526L194.263 175.734L258.59 170.615L264.649 170.149Z";
const ITERATE_DOT_PATH =
  "M264.649 78H268.844L275.836 78.9308L282.362 80.7924L287.49 83.5848L292.151 87.7734L295.414 92.8928L297.278 96.616L299.143 105.924L299.609 113.836L299.143 118.49L298.677 122.213L296.812 128.729L293.549 134.779L290.286 138.502L286.091 141.76L282.362 143.621L278.167 145.018L274.438 145.948L267.912 146.414H260.92L254.394 145.483L249.267 144.087L244.139 141.294L239.944 138.037L236.681 133.383L233.884 127.332L232.486 121.282L232.02 117.559V108.716L232.952 101.735L234.816 95.6852L237.613 90.1004L240.41 86.3772L246.936 82.1886L252.529 79.8616L259.522 78.4654L264.649 78Z";

/** The iterate mark — the letter i from the product logo. Also the face of
 * platform-chrome pages outside this module (the project-app sign-in page). */
function iterateMarkSvg(background: "black" | "white", foreground: "black" | "white"): string {
  return `<svg class="mark" viewBox="0 0 500 500" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="iterate"><rect width="500" height="500" fill="${background}" rx="112"/><g transform="translate(20 20) scale(0.92)"><path d="${ITERATE_I_PATH}" fill="${foreground}"/><path d="${ITERATE_DOT_PATH}" fill="${foreground}"/></g></svg>`;
}

export const ITERATE_MARK_SVG = iterateMarkSvg("black", "white");
const USERSPACE_FAVICON_SVG = iterateMarkSvg("white", "black");
export const WORKER_DEFAULT_FAVICON_PATH = "/.iterate/favicon.svg";

export function workerDefaultFaviconHtml(urlPrefix = ""): string {
  const href = escapeHtml(`${urlPrefix}${WORKER_DEFAULT_FAVICON_PATH}`);
  return `<link rel="icon" type="image/svg+xml" href="${href}" data-iterate-default-favicon>`;
}

/** The same-origin asset referenced by the injected link. Keeping this out of
 * a data URL lets ordinary `img-src 'self'` CSPs accept the default. */
export function workerDefaultFaviconResponse(request: Request): Response | null {
  if (new URL(request.url).pathname !== WORKER_DEFAULT_FAVICON_PATH) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  return new Response(request.method === "HEAD" ? null : USERSPACE_FAVICON_SVG, {
    headers: {
      "cache-control": "public, max-age=3600",
      "content-type": "image/svg+xml; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

export function relIncludesIcon(rel: string | null): boolean {
  return rel?.split(/\s+/).some((token) => token.toLowerCase() === "icon") ?? false;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const CSP_NONCE_PATTERN = /^[A-Za-z0-9_-]+$/u;

/**
 * Authorize one platform-injected style in every independently enforced CSP
 * policy. The nonce is added to the most specific directive that controls
 * style elements; policies that do not restrict styles stay untouched. When
 * styles inherit from default-src, copy that fallback into a new style-src
 * directive before adding the nonce. Adding a style nonce to default-src
 * would also authorize scripts whenever script-src is absent.
 *
 * This deliberately never adds unsafe-inline, a host source, or script
 * permission. Combining 'none' with a nonce is valid CSP: 'none' is ignored
 * only for the one element presenting that unguessable nonce.
 */
export function allowStyleNonceInCsp(policyList: string, nonce: string): string {
  if (!CSP_NONCE_PATTERN.test(nonce)) throw new Error("Invalid CSP nonce.");
  const nonceSource = `'nonce-${nonce}'`;
  return policyList
    .split(",")
    .map((policy) => {
      const directives = policy
        .split(";")
        .map((directive) => directive.trim())
        .filter(Boolean);
      const names = directives.map((directive) => directive.split(/\s+/u, 1)[0]?.toLowerCase());
      const target = names.includes("style-src-elem")
        ? "style-src-elem"
        : names.includes("style-src")
          ? "style-src"
          : null;
      if (target) {
        return directives
          .map((directive, index) => {
            if (names[index] !== target) return directive;
            const sources = directive.split(/\s+/u);
            return sources.includes(nonceSource) ? directive : `${directive} ${nonceSource}`;
          })
          .join("; ");
      }

      const defaultSourceIndex = names.indexOf("default-src");
      if (defaultSourceIndex === -1) return directives.join("; ");
      const defaultSources = directives[defaultSourceIndex]
        .split(/\s+/u)
        .slice(1)
        .filter((source) => source !== nonceSource);
      return [...directives, `style-src ${[...defaultSources, nonceSource].join(" ")}`].join("; ");
    })
    .join(", ");
}

function randomCspNonce(): string {
  let binary = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(18))) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function allowOverlayStyleInHeaders(headers: Headers, nonce: string): void {
  for (const name of ["content-security-policy", "content-security-policy-report-only"]) {
    const policy = headers.get(name);
    if (policy) headers.set(name, allowStyleNonceInCsp(policy, nonce));
  }
}

/** Everything the corner widget can say. */
type WorkerOverlayState =
  | { kind: "buildFailed"; message: string }
  | { kind: "building" }
  | { kind: "live"; commitOid: string }
  | { kind: "serveError" };

/** What each state shows in the tooltip and the click-open menu. */
function overlayText(state: WorkerOverlayState): { status: string; tip: string } {
  switch (state.kind) {
    case "live":
      return { status: "Live — serving the latest build.", tip: "iterate — live" };
    case "building":
      return {
        status:
          "Building this app — first build of this version. The page reloads when it's ready.",
        tip: "iterate — building this app…",
      };
    case "buildFailed":
      return {
        status: "Worker build failed — fix the worker source, then reload this page.",
        tip: "iterate — build failed, click for details",
      };
    case "serveError":
      return {
        status:
          "Something went wrong serving this app. The fault is on iterate's side, not this app's code. It's usually transient — the page retries by itself.",
        tip: "iterate — something went wrong, retrying",
      };
  }
}

/**
 * The corner widget is static HTML/CSS in a declarative shadow root: app CSS
 * cannot reach it, native details/summary owns click-open behavior, and even
 * script-src 'none' or Trusted Types pages can display it. A per-response
 * style nonce is supplied when ingress injects it into CSP-protected HTML.
 * The same fragment mounts directly on platform stand-in pages.
 */
export function workerOverlayHtml(
  state: WorkerOverlayState,
  options: { styleNonce?: string } = {},
): string {
  const text = overlayText(state);
  const short = state.kind === "live" ? state.commitOid.slice(0, 7) : "";
  const tip = short ? `${text.tip} (${short})` : text.tip;
  const nonceAttribute = options.styleNonce ? ` nonce="${escapeHtml(options.styleNonce)}"` : "";
  const isBusy = state.kind === "building" || state.kind === "serveError";
  const startOpen = state.kind === "buildFailed" || state.kind === "serveError";
  const detail =
    state.kind === "buildFailed" ? `<pre id="detail">${escapeHtml(state.message)}</pre>` : "";
  return `<iterate-worker-status data-iterate-worker-overlay>
  <template shadowrootmode="open">
  <style${nonceAttribute}>
    :host { all: initial !important; display: block !important; position: fixed !important; bottom: 16px !important; right: 16px !important; z-index: 2147483647 !important; }
    #widget { position: relative; font: 12px/1.5 ui-sans-serif, system-ui, sans-serif; }
    #details { margin: 0; padding: 0; }
    #badge { display: block; position: relative; width: 34px; height: 34px; padding: 0; border: 0; background: none; cursor: pointer; opacity: .55; transition: opacity .15s; list-style: none; }
    #badge::-webkit-details-marker { display: none; }
    #badge .mark { display: block; width: 100%; height: 100%; border-radius: 22.37%; box-shadow: 0 2px 10px rgba(0,0,0,.35); }
    #badge:hover, #details[open] #badge, #widget:not([data-kind="live"]) #badge { opacity: 1; }
    #ring { display: none; position: absolute; inset: -5px; width: 44px; height: 44px; color: #0a0a0a; }
    #ring rect { stroke-dasharray: 30 70; animation: trace 1.2s linear infinite; }
    [data-kind="building"] #ring, [data-kind="serveError"] #ring, [data-kind="buildFailed"] #ring { display: block; }
    [data-kind="serveError"] #ring, [data-kind="buildFailed"] #ring { color: #dc2626; }
    [data-kind="buildFailed"] #ring rect, [data-kind="serveError"] #ring rect { stroke-dasharray: none; animation: none; }
    [data-kind="building"] .mark { animation: pulse 1.6s ease-in-out infinite; }
    @keyframes trace { to { stroke-dashoffset: -100; } }
    @keyframes pulse { 50% { opacity: 0.45; } }
    #tip { display: none; position: absolute; bottom: 46px; right: 0; padding: 4px 8px; background: #0a0a0a; color: #fafafa; border-radius: 6px; white-space: nowrap; pointer-events: none; }
    #widget:hover #tip { display: block; }
    #details[open] ~ #tip { display: none; }
    #panel { position: absolute; bottom: 46px; right: 0; width: 320px; padding: 12px 14px; background: #0a0a0a; color: #fafafa; border: 1px solid #262626; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.45); }
    #panel header { display: flex; justify-content: space-between; color: #a3a3a3; margin-bottom: 4px; }
    #panel pre { margin: 8px 0 0; padding: 8px 10px; background: #171717; border: 1px solid #262626; border-radius: 8px; color: #fca5a5; font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-word; max-height: 40vh; overflow: auto; }
  </style>
  <div id="widget" data-kind="${state.kind}"${isBusy ? ' data-spinner="true"' : ""}>
    <details id="details"${startOpen ? " open" : ""}>
      <summary id="badge" aria-label="iterate worker status">
        <svg id="ring" viewBox="0 0 44 44" fill="none" aria-hidden="true"><rect x="1.5" y="1.5" width="41" height="41" rx="12" stroke="currentColor" stroke-width="2.5" pathLength="100" stroke-linecap="round" /></svg>
        ${ITERATE_MARK_SVG}
      </summary>
      <div id="panel">
        <header><span>iterate worker</span><span id="meta">${escapeHtml(short)}</span></header>
        <div id="status">${escapeHtml(text.status)}</div>
        ${detail}
      </div>
    </details>
    <div id="tip" role="tooltip">${escapeHtml(tip)}</div>
  </div>
  </template>
</iterate-worker-status>`;
}

/**
 * The stand-in shell: nothing to serve yet, so a bare white page mounts the
 * corner widget — deliberately the same code path (`workerOverlayHtml`) as
 * the overlay on a healthy page, so every serve state looks the same way.
 */
function standInPageHtml(input: {
  head?: string;
  script?: string;
  state: WorkerOverlayState;
  title: string;
  urlPrefix?: string;
}): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(input.title)}</title>
    ${workerDefaultFaviconHtml(input.urlPrefix)}
    ${input.head ?? ""}
    <style>
      body { margin: 0; min-height: 100vh; background: #fff; }
    </style>
  </head>
  <body>
    ${workerOverlayHtml(input.state)}
    ${input.script ?? ""}
  </body>
</html>`;
}

/**
 * Poll this URL until the marker header clears, then reload. A poll's fetch
 * tends to reuse the page's HTTP connection, which pins every retry to one
 * server isolate — observed live (2026-07-21): an error page re-polled one
 * poisoned isolate pair for 45 minutes while fresh connections served fine.
 * `hardReloadEveryMs` tears the page (and its connection) down on a cadence
 * so a retrying page eventually reaches a healthy path by itself.
 */
function reloadWhenHeaderClearsScript(
  headerName: string,
  intervalMs: number,
  options: { hardReloadEveryMs?: number } = {},
): string {
  const hardReloadNth = options.hardReloadEveryMs
    ? Math.max(2, Math.round(options.hardReloadEveryMs / intervalMs))
    : 0;
  return `let polls = 0;
      const poll = async () => {
        polls += 1;
        ${hardReloadNth ? `if (polls % ${hardReloadNth} === 0) { location.reload(); return; }` : ""}
        try {
          const res = await fetch(location.href, { cache: "no-store" });
          if (!res.headers.get(${JSON.stringify(headerName)})) { location.reload(); return; }
        } catch {}
        setTimeout(poll, ${intervalMs});
      };
      setTimeout(poll, ${intervalMs});`;
}

/**
 * The building page: white screen, the mark spinning its ring in the corner.
 * It polls its own URL and reloads the moment the building marker disappears
 * (no-JS clients fall back to a meta refresh). Served with the
 * 503/WORKER_BUILDING_HEADER contract by workerBuildingResponse, which also
 * owns that header's name — passed in here to keep the dependency one-way.
 */
export function workerBuildingPageHtml(buildingHeader: string, urlPrefix = ""): string {
  return standInPageHtml({
    head: `<noscript><meta http-equiv="refresh" content="3" /></noscript>`,
    script: `<script>${reloadWhenHeaderClearsScript(buildingHeader, 1_500)}</script>`,
    state: { kind: "building" },
    title: "Building…",
    urlPrefix,
  });
}

/**
 * The terminal case: the build failed. The mark turns red; the bundler's
 * error waits in the click-open menu. No automatic retry of a potentially
 * broken source — fixing it and reloading heals.
 */
export function workerBuildFailedResponse(error: unknown, urlPrefix = ""): Response {
  return new Response(
    standInPageHtml({
      state: { kind: "buildFailed", message: buildFailureMessageFromError(error) },
      title: "Worker build failed",
      urlPrefix,
    }),
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        [WORKER_BUILD_FAILED_HEADER]: "1",
        // The page already is the overlay — nothing more to inject.
        [OVERLAY_OPT_OUT_HEADER]: "1",
      },
      status: 500,
    },
  );
}

/**
 * The catch-all: something on iterate's side — not the app's source — broke
 * while serving. The cause is usually transient (a resource mid-provision, a
 * dependency hiccup), so the red ring keeps spinning and the page polls its
 * way back into the app; internals stay in the logs.
 */
export function workerServeErrorResponse(urlPrefix = ""): Response {
  return new Response(
    standInPageHtml({
      head: `<noscript><meta http-equiv="refresh" content="5" /></noscript>`,
      script: `<script>${reloadWhenHeaderClearsScript(WORKER_SERVE_ERROR_HEADER, 3_000, { hardReloadEveryMs: 45_000 })}</script>`,
      state: { kind: "serveError" },
      title: "Something went wrong",
      urlPrefix,
    }),
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "retry-after": "3",
        [WORKER_SERVE_ERROR_HEADER]: "1",
        // The page already is the overlay — nothing more to inject.
        [OVERLAY_OPT_OUT_HEADER]: "1",
      },
      status: 500,
    },
  );
}

/** The common streaming-transform boundary: a project-served HTML document,
 * not a socket, encoded body, or subresource. */
function workerHtmlDocumentCommit(request: Request, response: Response): string | null {
  if (response.status === 101 || response.webSocket || !response.body) return null;
  const raw = response.headers.get(WORKER_SERVE_HEADER);
  if (!raw) return null;
  if (!response.headers.get("content-type")?.includes("text/html")) return null;
  // A pre-encoded body (a worker returning bytes it compressed itself) cannot
  // be parsed, let alone transformed.
  if (response.headers.has("content-encoding")) return null;
  // Subresource fetches (XHR returning HTML fragments) don't need chrome;
  // absent sec-fetch-dest (curl, old clients) counts as a document.
  const dest = request.headers.get("sec-fetch-dest");
  if (dest && dest !== "document") return null;
  return raw.length > 0 ? raw : null;
}

export function workerOverlayDecision(request: Request, response: Response): string | null {
  const commitOid = workerHtmlDocumentCommit(request, response);
  if (!commitOid) return null;
  if (response.headers.has(OVERLAY_OPT_OUT_HEADER)) return null;
  return commitOid;
}

/**
 * Ingress's one call: dress a project-worker response in the platform's
 * user-space chrome. HTML documents get the default favicon at document end
 * unless the app supplied one anywhere, plus the scriptless widget before
 * </body>. A random style nonce is authorized in response-header and meta
 * CSPs, without granting any script capability. HTMLRewriter keeps the
 * transformation streaming; everything else passes through untouched.
 */
export function applyProjectWorkerOverlay(request: Request, response: Response): Response {
  if (!workerHtmlDocumentCommit(request, response)) return response;
  const commitOid = workerOverlayDecision(request, response);
  const urlPrefix = request.headers.get("x-iterate-url-prefix") ?? "";
  const styleNonce = !commitOid ? null : randomCspNonce();
  let hasFavicon = false;
  let hasOverlay = false;
  const rewriter = new HTMLRewriter()
    .on("link", {
      element(element) {
        hasFavicon ||= relIncludesIcon(element.getAttribute("rel"));
      },
    })
    .on("meta", {
      element(element) {
        if (!styleNonce) return;
        if (
          element.getAttribute("http-equiv")?.trim().toLowerCase() !== "content-security-policy"
        ) {
          return;
        }
        const policy = element.getAttribute("content");
        if (policy) {
          element.setAttribute("content", allowStyleNonceInCsp(policy, styleNonce));
        }
      },
    })
    .on("body", {
      element(element) {
        if (commitOid && styleNonce && !hasOverlay) {
          element.append(workerOverlayHtml({ commitOid, kind: "live" }, { styleNonce }), {
            html: true,
          });
          hasOverlay = true;
        }
      },
    })
    .onDocument({
      end(end) {
        // Wait until every app-authored link has been observed: rel=icon is
        // legal in the body too, and the app's icon always wins. Browsers
        // accept the fallback link at document end even without head/body.
        if (!hasFavicon) {
          end.append(workerDefaultFaviconHtml(urlPrefix), { html: true });
        }
        // Malformed/minimal HTML need not contain an explicit body. The
        // document-end fallback keeps the platform status present there too.
        if (commitOid && styleNonce && !hasOverlay) {
          end.append(workerOverlayHtml({ commitOid, kind: "live" }, { styleNonce }), {
            html: true,
          });
        }
      },
    });
  const transformed = rewriter.transform(response);
  const out = new Response(transformed.body, transformed);
  if (styleNonce) allowOverlayStyleInHeaders(out.headers, styleNonce);
  // The transform changes byte length, and fetch already decompressed the
  // upstream body — a copied length header would lie about this body.
  out.headers.delete("content-length");
  return out;
}
