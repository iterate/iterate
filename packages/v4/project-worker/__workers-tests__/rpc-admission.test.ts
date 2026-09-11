// The edge may withhold a response while a client leaves an HTTP request body open. This workers
// lane proves the distinct invariant we own: once the public `/api` handler sees a rejected body,
// it bounds its own reads, cancels the source, and returns its classified refusal promptly.
import { SELF } from "cloudflare:test";
import { expect, test } from "vitest";

const tooDeepFrame = `${"[".repeat(257)}${"]".repeat(257)}`;

test("/api bounds and cancels a continuing rejected public HTTP body", async () => {
  const encoder = new TextEncoder();
  let pulls = 0;
  let sourceController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const abort = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      sourceController = controller;
    },
    async pull(controller) {
      if (pulls++ === 0) {
        controller.enqueue(encoder.encode(tooDeepFrame));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.enqueue(encoder.encode(" ".repeat(1024)));
    },
  });
  const started = performance.now();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      SELF.fetch(
        new Request("https://test.local/api", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body,
          signal: abort.signal,
        }),
      ),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          abort.abort();
          reject(new Error("admission response exceeded its 5s hard deadline"));
        }, 5_000);
      }),
    ]);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      code: "RPC_ADMISSION_REJECTED",
      kind: "MESSAGE_TOO_COMPLEX",
    });
    expect(performance.now() - started).toBeLessThan(2_000);
    // `SELF.fetch` owns a transport wrapper, so a caller's producer need not receive `cancel()`.
    // The public-handler guarantee is the bounded pull count: it stops asking this unended source
    // for input as soon as admission refuses it.
    expect(pulls).toBeLessThan(50);
  } finally {
    if (deadline) clearTimeout(deadline);
    abort.abort();
    try {
      sourceController?.close();
    } catch {
      // Admission cancellation already closed the producer.
    }
  }
});
