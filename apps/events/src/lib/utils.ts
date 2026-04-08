import type { Event } from "@iterate-com/events-contract";

/**
 * Decode the DO's newline-delimited JSON event stream.
 *
 * The DO validates on append, and historical reads already trust stored rows, so
 * the live decoder stays tolerant too: one malformed line should not kill the
 * whole subscription. Semantic consumers can still use narrower `safeParse()`
 * checks where specific payload shapes matter.
 */
export async function* decodeEventStream(stream: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  const onAbort = () => {
    void reader.cancel();
  };

  try {
    if (signal?.aborted) {
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) {
          break;
        }

        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (line.length === 0) {
          continue;
        }

        const event = decodeEventLine(line);
        if (event) {
          yield event;
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      const event = decodeEventLine(buffer);
      if (event) {
        yield event;
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);

    if (!finished) {
      await reader.cancel();
    }

    reader.releaseLock();
  }
}

function decodeEventLine(line: string) {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn("[events] skipping non-object stream event line", { line });
      return null;
    }

    return parsed as Event;
  } catch (error) {
    console.warn("[events] skipping malformed stream event line", { error, line });
    return null;
  }
}
