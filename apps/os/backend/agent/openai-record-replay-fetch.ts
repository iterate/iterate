/**
 * OpenAI Record/Replay Fetch Wrapper
 *
 * A custom fetch implementation that can record OpenAI API responses to a fixture server
 * or replay them for deterministic testing.
 *
 * This runs in the Cloudflare Worker context and communicates with the fixture server
 * (which runs as a separate Node process with filesystem access).
 *
 * Fixtures are organized by test name with sequential request numbering.
 */

export type RecordReplayMode = "record" | "replay" | "passthrough";

export interface RecordReplayOptions {
  mode: RecordReplayMode;
  fixtureServerUrl: string;
  testName: string;
}

/**
 * Parse SSE (Server-Sent Events) response body into individual chunks.
 */
function parseSSEChunks(text: string): unknown[] {
  const chunks: unknown[] = [];
  const lines = text.split("\n");

  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const data = line.slice(6);
      if (data === "[DONE]") {
        continue;
      }
      try {
        chunks.push(JSON.parse(data));
      } catch {
        // Skip malformed JSON
      }
    }
  }

  return chunks;
}

/**
 * Convert chunks back to SSE format for replay.
 */
function chunksToSSE(chunks: unknown[]): string {
  const lines = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`);
  lines.push("data: [DONE]");
  lines.push(""); // Trailing newline
  return lines.join("\n\n");
}

/**
 * Create a fetch wrapper that records or replays OpenAI API responses.
 * Tracks request index internally and increments for each OpenAI API call.
 */
export function createRecordReplayFetch(options: RecordReplayOptions): typeof fetch {
  const { mode, fixtureServerUrl, testName } = options;

  if (mode === "passthrough") {
    return fetch;
  }

  // Track request index for sequential matching
  let requestIndex = 0;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    // Only intercept OpenAI API requests
    if (!url.includes("api.openai.com")) {
      return fetch(input, init);
    }

    const requestBody = init?.body ? JSON.parse(init.body as string) : null;
    const currentIndex = requestIndex;
    requestIndex++;

    if (mode === "replay") {
      return handleReplay(fixtureServerUrl, testName, currentIndex, url, requestBody);
    }

    if (mode === "record") {
      return handleRecord(fixtureServerUrl, testName, url, requestBody, input, init);
    }

    // Should never reach here
    return fetch(input, init);
  };
}

async function handleReplay(
  fixtureServerUrl: string,
  testName: string,
  requestIndex: number,
  originalUrl: string,
  actualRequestBody: unknown,
): Promise<Response> {
  const replayResponse = await fetch(`${fixtureServerUrl}/replay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      testName,
      requestIndex,
      actualRequest: {
        url: originalUrl,
        method: "POST",
        body: actualRequestBody,
      },
    }),
  });

  const replayData = (await replayResponse.json()) as {
    found: boolean;
    response?: {
      status: number;
      headers: Record<string, string>;
      chunks: unknown[];
    };
    error?: string;
    diff?: string;
  };

  if (!replayData.found) {
    throw new Error(`[openai-record-replay] ${replayData.error}`);
  }

  if (replayData.error) {
    // Request was found but body didn't match
    throw new Error(`[openai-record-replay] ${replayData.error}`);
  }

  if (!replayData.response) {
    throw new Error(`[openai-record-replay] No response data in fixture`);
  }

  // Reconstruct the response from cached chunks
  const { status, headers, chunks } = replayData.response;

  // Check if this is a streaming response
  const isStreaming = headers["content-type"]?.includes("text/event-stream");

  if (isStreaming) {
    // Return a streaming response
    const sseBody = chunksToSSE(chunks);
    return new Response(sseBody, {
      status,
      headers: {
        ...headers,
        "content-type": "text/event-stream",
      },
    });
  }

  // Non-streaming response - return the first chunk as JSON
  return new Response(JSON.stringify(chunks[0] ?? {}), {
    status,
    headers: {
      ...headers,
      "content-type": "application/json",
    },
  });
}

async function handleRecord(
  fixtureServerUrl: string,
  testName: string,
  url: string,
  requestBody: unknown,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  // Make the real request
  const response = await fetch(input, init);

  // Clone the response so we can read the body
  const clonedResponse = response.clone();
  const responseText = await clonedResponse.text();

  // Parse response based on content type
  const contentType = response.headers.get("content-type") ?? "";
  const isStreaming = contentType.includes("text/event-stream");

  const chunks = isStreaming ? parseSSEChunks(responseText) : [JSON.parse(responseText)];

  // Extract headers
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  // Send to fixture server for recording
  await fetch(`${fixtureServerUrl}/record`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      testName,
      request: {
        url,
        method: init?.method ?? "POST",
        body: requestBody,
      },
      response: {
        status: response.status,
        headers: responseHeaders,
        chunks,
      },
    }),
  }).catch((err) => {
    console.error("[openai-record-replay] Failed to record fixture:", err);
  });

  // Return a new response with the same body
  // We need to reconstruct because we consumed the original
  if (isStreaming) {
    return new Response(responseText, {
      status: response.status,
      headers: response.headers,
    });
  }

  return new Response(responseText, {
    status: response.status,
    headers: response.headers,
  });
}
