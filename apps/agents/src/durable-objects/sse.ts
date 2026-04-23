/**
 * Minimal async-iterator SSE parser for `text/event-stream` byte streams (e.g.
 * the `ReadableStream` returned by `env.AI.run(..., { stream: true })`).
 *
 * Yields each `data:` payload parsed as JSON. Skips blank/empty messages and
 * the OpenAI-style `[DONE]` sentinel. Does NOT surface the `event:` line —
 * callers that need the provider's event-type discriminator (e.g. Anthropic)
 * should switch on fields inside the JSON payload instead.
 */
export async function* parseSseStream<T = unknown>(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<T> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE messages are separated by a blank line. Keep the trailing partial
    // (if any) for the next read.
    const messages = buffer.split("\n\n");
    buffer = messages.pop() ?? "";
    for (const message of messages) {
      const data = message
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("");
      if (!data || data === "[DONE]") continue;
      yield JSON.parse(data) as T;
    }
  }
}
