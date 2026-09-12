import { expect, test, vi } from "vitest";
import { bridgeProjectRequestBody } from "./project-request-body-bridge.ts";

function requestWithBody(body: ReadableStream<Uint8Array>): Request {
  return new Request("https://project.example/", {
    body,
    duplex: "half",
    method: "POST",
  } as RequestInit & { duplex: "half" });
}

function forwardedRequest(body: ReadableStream<Uint8Array>): Request {
  return new Request("https://project.example/", {
    body,
    duplex: "half",
    method: "POST",
  } as RequestInit & { duplex: "half" });
}

test("cancels an unread inbound project request after the 404 response completes", async () => {
  const cancel = vi.fn();
  const bridge = bridgeProjectRequestBody(
    requestWithBody(new ReadableStream<Uint8Array>({ cancel })),
  );

  const response = await bridge.finish(new Response("not found", { status: 404 }));

  await expect(response.text()).resolves.toBe("not found");
  expect(cancel).toHaveBeenCalledOnce();
});

test("keeps the inbound request flowing through a direct streaming response", async () => {
  const bridge = bridgeProjectRequestBody(
    requestWithBody(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("echoed body"));
          controller.close();
        },
      }),
    ),
  );
  const response = await bridge.finish(new Response(forwardedRequest(bridge.body!).body));

  await expect(response.text()).resolves.toBe("echoed body");
});

test("keeps the inbound request flowing through a transformed streaming response", async () => {
  const bridge = bridgeProjectRequestBody(
    requestWithBody(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("transformed body"));
          controller.close();
        },
      }),
    ),
  );
  const response = await bridge.finish(
    new Response(forwardedRequest(bridge.body!).body?.pipeThrough(new TransformStream())),
  );

  await expect(response.text()).resolves.toBe("transformed body");
});

test("cancels a live inbound request when the response consumer disconnects", async () => {
  const cancel = vi.fn();
  let sent = false;
  const bridge = bridgeProjectRequestBody(
    requestWithBody(
      new ReadableStream<Uint8Array>({
        cancel,
        pull(controller) {
          if (sent) return;
          sent = true;
          controller.enqueue(new TextEncoder().encode("first chunk"));
        },
      }),
    ),
  );
  const response = await bridge.finish(new Response(forwardedRequest(bridge.body!).body));
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Expected a streaming response body.");

  await expect(reader.read()).resolves.toMatchObject({ done: false });
  await expect(reader.cancel("consumer disconnected")).resolves.toBeUndefined();
  expect(cancel).toHaveBeenCalledOnce();
});

test("surfaces an inbound request failure instead of treating it as cleanup", async () => {
  const bridge = bridgeProjectRequestBody(
    requestWithBody(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("source failed"));
        },
      }),
    ),
  );
  const response = await bridge.finish(new Response("not found", { status: 404 }));

  await expect(response.text()).rejects.toThrow("source failed");
});
