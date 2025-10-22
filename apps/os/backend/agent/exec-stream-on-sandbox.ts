import type { ExecEvent, Sandbox, StreamOptions } from "@cloudflare/sandbox";

/**
 * Execute a command with streaming output by making a direct fetch request to the container
 * This bypasses the RPC layer and goes directly to the container's SSE endpoint
 *
 * @param stub - The Durable Object Sandbox stub
 * @param sessionId - Required session ID for command execution
 * @param command - The command to execute
 * @param options - Optional streaming options (signal for cancellation)
 * @returns AsyncIterable of ExecEvent objects
 *
 * @example
 * ```typescript
 * const sandbox = getSandbox(env.Sandbox, "my-sandbox");
 * const session = await sandbox.createSession({ id: "my-session" });
 *
 * for await (const event of execStreamOnContainer(sandbox, session.id, "ls -la")) {
 *   if (event.type === "stdout") {
 *     console.log(event.data);
 *   }
 * }
 * ```
 */
export async function execStreamOnSandbox(
  stub: DurableObjectStub<Sandbox<unknown>>,
  sessionId: string,
  command: string,
  options?: StreamOptions,
): Promise<AsyncIterable<ExecEvent>> {
  const { responseToAsyncIterable } = await import("@cloudflare/sandbox");

  // Construct the request to the container's streaming endpoint
  // we do this rather than using the RPC layer because the RPC layer adds unnecessary extra serialization
  const request = new Request("http://container/api/execute/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      sessionId,
      command,
    }),
    signal: options?.signal,
  });

  // Make the fetch request through the Durable Object stub
  // This will route through Sandbox.fetch() -> containerFetch() -> container
  const response = await stub.fetch(request);

  // Check if the request was successful
  if (!response.ok) {
    let errorMessage = `Failed to execute command: ${response.status} ${response.statusText}`;
    try {
      const errorData = (await response.json()) as { error?: string };
      if (errorData.error) {
        errorMessage = errorData.error;
      }
    } catch {
      // If we can't parse the error response, use the default message
    }
    throw new Error(errorMessage);
  }

  // Ensure we have a response body
  if (!response.body) {
    throw new Error("No response body for streaming execution");
  }

  // Parse the SSE stream and yield events
  return responseToAsyncIterable<ExecEvent>(response, options?.signal);
}
