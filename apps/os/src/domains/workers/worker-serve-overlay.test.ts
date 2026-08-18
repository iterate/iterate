import { describe, expect, test } from "vitest";
import {
  OVERLAY_OPT_OUT_HEADER,
  WORKER_BUILD_FAILED_HEADER,
  WORKER_SERVE_ERROR_HEADER,
  WORKER_SERVE_HEADER,
  withWorkerCommit,
} from "./worker-serve-info.ts";
import {
  allowStyleNonceInCsp,
  relIncludesIcon,
  WORKER_DEFAULT_FAVICON_PATH,
  workerDefaultFaviconHtml,
  workerDefaultFaviconResponse,
  workerBuildFailedResponse,
  workerOverlayDecision,
  workerOverlayHtml,
  workerServeErrorResponse,
} from "./worker-serve-overlay.ts";

// The HTMLRewriter injection itself is workerd-only. These tests cover the
// decision, the trusted header stamping, and the injected fragment's escaping.

const commitOid = "c0ffee1234";

function htmlResponse(headers: Record<string, string> = {}): Response {
  return new Response("<html><body>hi</body></html>", {
    headers: {
      "content-type": "text/html; charset=utf-8",
      [WORKER_SERVE_HEADER]: commitOid,
      ...headers,
    },
  });
}

describe("withWorkerCommit", () => {
  test("stamps the platform's repo commit onto the response", () => {
    const stamped = withWorkerCommit(new Response("ok"), commitOid);
    expect(stamped.headers.get(WORKER_SERVE_HEADER)).toBe(commitOid);
  });

  test("always drops whatever user code set — even with nothing to say", () => {
    const spoofed = new Response("ok", {
      headers: { [WORKER_SERVE_HEADER]: "spoof" },
    });
    expect(withWorkerCommit(spoofed, undefined).headers.get(WORKER_SERVE_HEADER)).toBeNull();
  });

  test("keeps status, other headers, and body intact", async () => {
    const stamped = withWorkerCommit(
      new Response("payload", { headers: { "x-app": "1" }, status: 418 }),
      commitOid,
    );
    expect(stamped.status).toBe(418);
    expect(stamped.headers.get("x-app")).toBe("1");
    expect(await stamped.text()).toBe("payload");
  });

  test("keeps ownership of the dynamic-worker response after stamping it", () => {
    let disposeCount = 0;
    const dynamicWorkerResponse = Object.assign(new Response("ok"), {
      [Symbol.dispose]() {
        disposeCount += 1;
      },
    });

    const stamped = withWorkerCommit(dynamicWorkerResponse, commitOid) as Response & Disposable;
    stamped[Symbol.dispose]();

    expect(disposeCount).toBe(1);
  });
});

describe("workerOverlayDecision", () => {
  const documentRequest = new Request("https://app.example.com/");

  test("injects for an HTML document carrying serve info", () => {
    expect(workerOverlayDecision(documentRequest, htmlResponse())).toBe(commitOid);
  });

  test("injects for CSP-protected HTML because the transform authorizes only its style", () => {
    expect(
      workerOverlayDecision(
        documentRequest,
        htmlResponse({ "content-security-policy": "default-src 'none'" }),
      ),
    ).toBe(commitOid);
  });

  test.each([
    [
      "no serve header",
      new Response("<html></html>", { headers: { "content-type": "text/html" } }),
    ],
    ["non-HTML response", htmlResponse({ "content-type": "application/json" })],
    ["overlay opt-out", htmlResponse({ [OVERLAY_OPT_OUT_HEADER]: "off" })],
    ["empty commit", htmlResponse({ [WORKER_SERVE_HEADER]: "" })],
    ["a pre-encoded body we cannot parse", htmlResponse({ "content-encoding": "gzip" })],
  ])("stays out of %s", (_name, response) => {
    expect(workerOverlayDecision(documentRequest, response)).toBeNull();
  });

  test("stays out of body-less responses", () => {
    const bodyless = new Response(null, {
      headers: {
        "content-type": "text/html",
        [WORKER_SERVE_HEADER]: commitOid,
      },
      status: 204,
    });
    expect(workerOverlayDecision(documentRequest, bodyless)).toBeNull();
  });

  test("stays out of subresource fetches, counts absent sec-fetch-dest as a document", () => {
    const subresource = new Request("https://app.example.com/api", {
      headers: { "sec-fetch-dest": "empty" },
    });
    expect(workerOverlayDecision(subresource, htmlResponse())).toBeNull();
    expect(workerOverlayDecision(documentRequest, htmlResponse())).not.toBeNull();
  });
});

describe("CSP-safe worker overlay styles", () => {
  const nonce = "c3Atc2FmZS1ub25jZQ";
  const source = `'nonce-${nonce}'`;

  test("authorizes one nonce through the directive that governs style elements", () => {
    expect(allowStyleNonceInCsp("default-src 'none'; img-src 'self'", nonce)).toBe(
      `default-src 'none'; img-src 'self'; style-src 'none' ${source}`,
    );
    expect(allowStyleNonceInCsp("default-src 'none'; style-src 'self'", nonce)).toBe(
      `default-src 'none'; style-src 'self' ${source}`,
    );
    expect(
      allowStyleNonceInCsp(
        "default-src 'none'; style-src 'self'; style-src-elem https://styles.example",
        nonce,
      ),
    ).toBe(`default-src 'none'; style-src 'self'; style-src-elem https://styles.example ${source}`);
  });

  test("updates every independently enforced policy", () => {
    expect(
      allowStyleNonceInCsp("default-src 'none', default-src 'self'; style-src 'none'", nonce),
    ).toBe(
      `default-src 'none'; style-src 'none' ${source}, default-src 'self'; style-src 'none' ${source}`,
    );
  });

  test("never exposes its style nonce through the script fallback", () => {
    const policy = allowStyleNonceInCsp("default-src 'none'; img-src 'self'", nonce);
    expect(policy).toContain(`style-src 'none' ${source}`);
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toContain(`default-src 'none' ${source}`);
  });

  test("does not restrict a policy that leaves styles unrestricted or duplicate the nonce", () => {
    expect(allowStyleNonceInCsp("img-src 'none'; connect-src 'self'", nonce)).toBe(
      "img-src 'none'; connect-src 'self'",
    );
    expect(allowStyleNonceInCsp(`style-src 'none' ${source}`, nonce)).toBe(
      `style-src 'none' ${source}`,
    );
  });

  test("rejects a nonce that is unsafe to place in CSP and HTML", () => {
    expect(() => allowStyleNonceInCsp("default-src 'none'", `bad'; style-src *`)).toThrow(
      "Invalid CSP nonce",
    );
  });
});

describe("user-space favicon", () => {
  test("recognizes icon as a case-insensitive rel token", () => {
    expect(relIncludesIcon("icon")).toBe(true);
    expect(relIncludesIcon("shortcut ICON")).toBe(true);
    expect(relIncludesIcon("apple-touch-icon")).toBe(false);
    expect(relIncludesIcon(null)).toBe(false);
  });

  test("uses an inverted iterate mark", async () => {
    const html = workerDefaultFaviconHtml();
    expect(html).toContain('rel="icon"');
    expect(html).toContain("data-iterate-default-favicon");
    expect(html).toContain(`href="${WORKER_DEFAULT_FAVICON_PATH}"`);
    const response = workerDefaultFaviconResponse(
      new Request(`https://app.example.com${WORKER_DEFAULT_FAVICON_PATH}`),
    );
    expect(response).not.toBeNull();
    expect(response!.headers.get("content-type")).toContain("image/svg+xml");
    const svg = await response!.text();
    expect(svg).toContain('<rect width="500" height="500" fill="white"');
    expect(svg.match(/fill="black"/g)).toHaveLength(2);
  });

  test("includes the browser-visible project prefix on the path lane", () => {
    expect(workerDefaultFaviconHtml("/prj_test")).toContain(
      `href="/prj_test${WORKER_DEFAULT_FAVICON_PATH}"`,
    );
  });
});

describe("workerOverlayHtml", () => {
  test("carries the iterate mark and serve info in a scriptless shadow component", () => {
    const html = workerOverlayHtml(
      { commitOid, kind: "live" },
      { styleNonce: "c3Atc2FmZS1ub25jZQ" },
    );
    expect(html).toContain('viewBox="0 0 500 500"');
    expect(html).toContain("c0ffee1");
    expect(html).toContain('data-kind="live"');
    expect(html).toContain('<template shadowrootmode="open">');
    expect(html).toContain('<style nonce="c3Atc2FmZS1ub25jZQ">');
    expect(html).not.toContain("<script");
  });

  test("loading and error states carry the ring, the spinner marker, and the red color", () => {
    const building = workerOverlayHtml({ kind: "building" });
    expect(building).toContain('data-kind="building"');
    expect(building).toContain('data-spinner="true"');
    expect(building).toContain('id="ring"');
    const failed = workerOverlayHtml({ kind: "buildFailed", message: "boom" });
    expect(failed).toContain('data-kind="buildFailed"');
    expect(failed).not.toContain('data-spinner="true"');
    expect(failed).toContain("#dc2626");
    // Failure details start visible; everything else keeps the native details closed.
    expect(failed).toContain('<details id="details" open>');
    expect(building).toContain('<details id="details">');
    // The live badge never shows the ring machinery as active state.
    expect(workerOverlayHtml({ commitOid, kind: "live" })).not.toContain('data-spinner="true"');
  });

  test("serve metadata cannot break out of the static component markup", () => {
    const html = workerOverlayHtml({
      kind: "buildFailed",
      message: 'evil</script><script>alert("x")</script>',
    });
    expect(html).not.toContain("<script");
    expect(html).toContain("evil&lt;/script&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });
});

describe("workerServeErrorResponse", () => {
  test("marked, self-retrying, overlay-exempt 500 that keeps internals in the logs", async () => {
    const response = workerServeErrorResponse("/prj_test");
    expect(response.status).toBe(500);
    expect(response.headers.get(WORKER_SERVE_ERROR_HEADER)).toBe("1");
    expect(response.headers.get(OVERLAY_OPT_OUT_HEADER)).toBe("1");
    expect(response.headers.get("retry-after")).not.toBeNull();
    const body = await response.text();
    // JS clients poll for the marker to clear; no-JS clients meta-refresh.
    expect(body).toContain(WORKER_SERVE_ERROR_HEADER);
    expect(body).toContain('<noscript><meta http-equiv="refresh"');
    expect(body).toContain('data-kind="serveError"');
    // The retry loop periodically hard-reloads to escape a poisoned
    // connection-pinned isolate; the building page deliberately does not.
    expect(body).toContain("polls % 15");
    // An error pops its details open immediately; nothing spins on it.
    expect(body).toContain('<div id="panel">');
    expect(body).toContain('[data-kind="serveError"] #ring rect { stroke-dasharray: none');
    expect(body).toContain("data-iterate-default-favicon");
    expect(body).toContain(`href="/prj_test${WORKER_DEFAULT_FAVICON_PATH}"`);
  });
});

describe("workerBuildFailedResponse", () => {
  test("marked 500 with the bundler's error, script-inert, overlay-exempt", async () => {
    const response = workerBuildFailedResponse(
      new Error('Could not resolve "<b>zod</b>"'),
      "/prj_test",
    );
    expect(response.status).toBe(500);
    expect(response.headers.get(WORKER_BUILD_FAILED_HEADER)).toBe("1");
    expect(response.headers.get(OVERLAY_OPT_OUT_HEADER)).toBe("1");
    const body = await response.text();
    // The message is HTML-escaped before it enters the static component.
    expect(body).toContain("Could not resolve");
    expect(body).toContain("&lt;b&gt;zod&lt;/b&gt;");
    expect(body).not.toContain("<b>zod</b>");
    expect(body).toContain("then reload this page");
    expect(body).not.toContain("const poll = async");
    expect(body).toContain("data-iterate-default-favicon");
    expect(body).toContain(`href="/prj_test${WORKER_DEFAULT_FAVICON_PATH}"`);
  });
});
