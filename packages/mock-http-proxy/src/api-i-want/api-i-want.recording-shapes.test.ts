import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildForwardedHeader } from "@iterate-com/shared/forwarded-header";
import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import type { HarWithExtensions } from "../har-type.ts";
import { useMockHttpServer, useTemporaryDirectory } from "./test-helpers.ts";

async function readHar(path: string): Promise<HarWithExtensions> {
  return JSON.parse(await readFile(path, "utf8")) as HarWithExtensions;
}

function proxyHeaders(host: string): Record<string, string> {
  const forwarded = buildForwardedHeader({
    for: "203.0.113.42",
    host,
    proto: "https",
  });
  if (!forwarded) {
    throw new Error("expected forwarded header value");
  }
  return {
    forwarded,
  };
}

describe("records mocked request/response shapes", () => {
  using tmpDir = useTemporaryDirectory("mock-http-proxy-api-recording-shapes-");

  test("records mocked binary file upload", async () => {
    const harPath = join(tmpDir.path, "mocked-binary-upload.har");
    const body = Buffer.from([0, 255, 7, 9, 11, 13]);

    await using server = await useMockHttpServer({
      recorder: { harPath, includeHandledRequests: true },
      onUnhandledRequest: "error",
    });
    server.use(
      http.put("https://upload.example.com/files", () => {
        return HttpResponse.json({ ok: true, bytes: body.byteLength });
      }),
    );

    const response = await fetch(`${server.url}/files`, {
      method: "PUT",
      headers: {
        ...proxyHeaders("upload.example.com"),
        "content-type": "application/octet-stream",
      },
      body,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, bytes: body.byteLength });

    await server.writeHar();
    const har = await readHar(harPath);
    const entry = har.log.entries.find((candidate) => candidate.request.url.includes("/files"));
    expect(entry).toBeDefined();
    expect(entry?.request.postData?.mimeType).toBe("application/octet-stream");
    expect(entry?.request.postData?.text).toBe(body.toString("base64"));
    expect(entry?.response.content.mimeType).toContain("application/json");
  });

  test("records mocked multipart form upload", async () => {
    const harPath = join(tmpDir.path, "mocked-multipart.har");

    await using server = await useMockHttpServer({
      recorder: { harPath, includeHandledRequests: true },
      onUnhandledRequest: "error",
    });
    server.use(
      http.post("https://forms.example.com/submit", () => {
        return HttpResponse.json({
          ok: true,
          note: "hello-form",
          fileName: "note.txt",
        });
      }),
    );

    const form = new FormData();
    form.set("note", "hello-form");
    form.set("attachment", new File(["alpha\nbeta"], "note.txt", { type: "text/plain" }));

    const response = await fetch(`${server.url}/submit`, {
      method: "POST",
      headers: proxyHeaders("forms.example.com"),
      body: form,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      note: "hello-form",
      fileName: "note.txt",
    });

    await server.writeHar();
    const har = await readHar(harPath);
    const entry = har.log.entries.find((candidate) => candidate.request.url.includes("/submit"));
    expect(entry).toBeDefined();
    expect(entry?.request.postData?.mimeType).toContain("multipart/form-data");
    expect(entry?.request.postData?.text).toContain('name="note"');
    expect(entry?.request.postData?.text).toContain("hello-form");
    expect(entry?.request.postData?.text).toContain('filename="note.txt"');
  });

  test("records mocked SSE response body", async () => {
    const harPath = join(tmpDir.path, "mocked-sse.har");
    const sseBody = "event: status\ndata: one\n\nevent: status\ndata: two\n\n";

    await using server = await useMockHttpServer({
      recorder: { harPath, includeHandledRequests: true },
      onUnhandledRequest: "error",
    });
    server.use(
      http.get("https://events.example.com/stream", () => {
        return new HttpResponse(sseBody, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          },
        });
      }),
    );

    const response = await fetch(`${server.url}/stream`, {
      headers: proxyHeaders("events.example.com"),
    });
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(sseBody);

    await server.writeHar();
    const har = await readHar(harPath);
    const entry = har.log.entries.find((candidate) => candidate.request.url.includes("/stream"));
    expect(entry).toBeDefined();
    expect(entry?.response.content.mimeType).toContain("text/event-stream");
    expect(entry?.response.content.text).toBe(sseBody);
  });
});
