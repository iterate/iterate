import { describe, expect, it } from "vitest";
import {
  stampHtmlWorkerVersion,
  WORKER_VERSION_RESPONSE_HEADER,
} from "./worker-response-version.ts";

describe("stampHtmlWorkerVersion", () => {
  it("stamps a streamed HTML response without changing its response contract", async () => {
    const original = new Response("<!doctype html><title>OS</title>", {
      headers: { "content-type": "text/html; charset=utf-8", "x-existing": "kept" },
      status: 203,
      statusText: "Non-Authoritative Information",
    });

    const stamped = stampHtmlWorkerVersion(original, "version-new");

    expect(stamped).not.toBe(original);
    expect(stamped.status).toBe(203);
    expect(stamped.statusText).toBe("Non-Authoritative Information");
    expect(stamped.headers.get("x-existing")).toBe("kept");
    expect(stamped.headers.get(WORKER_VERSION_RESPONSE_HEADER)).toBe("version-new");
    await expect(stamped.text()).resolves.toContain("<title>OS</title>");
  });

  it("leaves non-document responses untouched", () => {
    const response = Response.json({ ok: true });

    expect(stampHtmlWorkerVersion(response, "version-new")).toBe(response);
    expect(response.headers.has(WORKER_VERSION_RESPONSE_HEADER)).toBe(false);
  });
});
