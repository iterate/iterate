import { describe, expect, test } from "vitest";
import {
  OVERLAY_OPT_OUT_HEADER,
  WORKER_BUILD_FAILED_HEADER,
  WORKER_SERVE_ERROR_HEADER,
  WORKER_SERVE_HEADER,
  withWorkerCommit,
} from "./worker-serve-info.ts";
import {
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
});

describe("workerOverlayDecision", () => {
  const documentRequest = new Request("https://app.example.com/");

  test("injects for an HTML document carrying serve info", () => {
    expect(workerOverlayDecision(documentRequest, htmlResponse())).toBe(commitOid);
  });

  test.each([
    [
      "no serve header",
      new Response("<html></html>", { headers: { "content-type": "text/html" } }),
    ],
    ["non-HTML response", htmlResponse({ "content-type": "application/json" })],
    ["overlay opt-out", htmlResponse({ [OVERLAY_OPT_OUT_HEADER]: "off" })],
    ["a page with its own CSP", htmlResponse({ "content-security-policy": "default-src 'self'" })],
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

describe("workerOverlayHtml", () => {
  test("carries the iterate mark and the serve info", () => {
    const html = workerOverlayHtml(commitOid);
    expect(html).toContain('viewBox="0 0 500 500"');
    expect(html).toContain('"c0ffee1234"');
  });

  test("serve metadata cannot break out of the script element", () => {
    const html = workerOverlayHtml('evil</script><script>alert("x")</script>');
    // Only the fragment's own tags — the payload's are <-escaped inert.
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain("\\u003c/script>");
  });
});

describe("workerServeErrorResponse", () => {
  test("marked, self-retrying, overlay-exempt 500 that keeps internals in the logs", async () => {
    const response = workerServeErrorResponse();
    expect(response.status).toBe(500);
    expect(response.headers.get(WORKER_SERVE_ERROR_HEADER)).toBe("1");
    expect(response.headers.get(OVERLAY_OPT_OUT_HEADER)).toBe("1");
    expect(response.headers.get("retry-after")).not.toBeNull();
    const body = await response.text();
    // JS clients poll for the marker to clear; no-JS clients meta-refresh.
    expect(body).toContain(WORKER_SERVE_ERROR_HEADER);
    expect(body).toContain('<noscript><meta http-equiv="refresh"');
    expect(body).toContain("iterate");
  });
});

describe("workerBuildFailedResponse", () => {
  test("marked 500 with the bundler's error, HTML-escaped, overlay-exempt", async () => {
    const response = workerBuildFailedResponse(new Error('Could not resolve "<b>zod</b>"'));
    expect(response.status).toBe(500);
    expect(response.headers.get(WORKER_BUILD_FAILED_HEADER)).toBe("1");
    expect(response.headers.get(OVERLAY_OPT_OUT_HEADER)).toBe("1");
    const body = await response.text();
    expect(body).toContain("Could not resolve &quot;&lt;b&gt;zod&lt;/b&gt;&quot;");
    expect(body).not.toContain("<b>zod</b>");
    expect(body).toContain("then reload this page");
    expect(body).not.toContain("const poll = async");
  });
});
