import { describe, expect, test } from "vitest";
import {
  OVERLAY_OPT_OUT_HEADER,
  stripWorkerServeInfo,
  WORKER_BUILD_FAILED_HEADER,
  WORKER_SERVE_HEADER,
  type WorkerServeInfo,
  withWorkerServeInfo,
} from "./worker-serve-info.ts";
import {
  workerBuildFailedResponse,
  workerOverlayDecision,
  workerOverlayHtml,
} from "./worker-serve-overlay.ts";

// The HTMLRewriter injection itself is workerd-only and proven in e2e
// (worker-stale-serve.e2e.test.ts); these tests cover the decision, the
// header stamping, and the injected fragment's escaping.

const freshInfo: WorkerServeInfo = { commitOid: "c0ffee1234", status: "fresh" };

function htmlResponse(headers: Record<string, string> = {}): Response {
  return new Response("<html><body>hi</body></html>", {
    headers: {
      "content-type": "text/html; charset=utf-8",
      [WORKER_SERVE_HEADER]: JSON.stringify(freshInfo),
      ...headers,
    },
  });
}

describe("withWorkerServeInfo", () => {
  test("stamps platform serve info onto the response", () => {
    const stamped = withWorkerServeInfo(new Response("ok"), freshInfo);
    expect(JSON.parse(stamped.headers.get(WORKER_SERVE_HEADER)!)).toEqual(freshInfo);
  });

  test("always drops whatever user code set — even with nothing to say", () => {
    const spoofed = new Response("ok", {
      headers: { [WORKER_SERVE_HEADER]: JSON.stringify({ status: "fresh" }) },
    });
    expect(stripWorkerServeInfo(spoofed).headers.get(WORKER_SERVE_HEADER)).toBeNull();
  });

  test("keeps status, other headers, and body intact", async () => {
    const stamped = withWorkerServeInfo(
      new Response("payload", { headers: { "x-app": "1" }, status: 418 }),
      freshInfo,
    );
    expect(stamped.status).toBe(418);
    expect(stamped.headers.get("x-app")).toBe("1");
    expect(await stamped.text()).toBe("payload");
  });
});

describe("workerOverlayDecision", () => {
  const documentRequest = new Request("https://app.example.com/");

  test("injects for an HTML document carrying serve info", () => {
    expect(workerOverlayDecision(documentRequest, htmlResponse())).toEqual(freshInfo);
  });

  test.each([
    [
      "no serve header",
      new Response("<html></html>", { headers: { "content-type": "text/html" } }),
    ],
    ["non-HTML response", htmlResponse({ "content-type": "application/json" })],
    ["overlay opt-out", htmlResponse({ [OVERLAY_OPT_OUT_HEADER]: "off" })],
    ["a page with its own CSP", htmlResponse({ "content-security-policy": "default-src 'self'" })],
    ["malformed serve info", htmlResponse({ [WORKER_SERVE_HEADER]: "not json" })],
    ["serve info that fails the schema", htmlResponse({ [WORKER_SERVE_HEADER]: '{"status":"?"}' })],
    ["a pre-encoded body we cannot parse", htmlResponse({ "content-encoding": "gzip" })],
  ])("stays out of %s", (_name, response) => {
    expect(workerOverlayDecision(documentRequest, response)).toBeNull();
  });

  test("stays out of body-less responses", () => {
    const bodyless = new Response(null, {
      headers: {
        "content-type": "text/html",
        [WORKER_SERVE_HEADER]: JSON.stringify(freshInfo),
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
    const html = workerOverlayHtml(freshInfo);
    expect(html).toContain('viewBox="0 0 500 500"');
    expect(html).toContain('"commitOid":"c0ffee1234"');
  });

  test("a failure message cannot break out of the script element", () => {
    const html = workerOverlayHtml({
      failure: {
        at: "2026-07-17T00:00:00.000Z",
        message: 'evil</script><script>alert("x")</script>',
      },
      reason: "build-failed",
      status: "stale",
    });
    // Only the fragment's own tags — the payload's are <-escaped inert.
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain("\\u003c/script>");
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
    // Self-healing: the page polls for the marker header to disappear.
    expect(body).toContain(WORKER_BUILD_FAILED_HEADER);
  });
});
