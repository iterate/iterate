type SSEMessage = {
  event: string;
  data: string;
};

function formatSSEMessage(event: string, data: string): string {
  const lines = data
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => `data: ${line}`)
    .join("\n");
  return `event: ${event}\n${lines || "data: (empty)"}\n\n`;
}

// Custom implemented sse stream helper
// waiting on https://github.com/honojs/hono/pull/4543 to just use hono's streamSSE helper
export function intoImmediateSSEResponse(data: SSEMessage[]) {
  // Filter out messages with empty data (except terminating events)
  const filteredData = data.filter(
    (m) => m.data.trim() !== "" || m.event === "complete" || m.event === "error",
  );

  const sseStream = new ReadableStream({
    start(controller) {
      // Send SSE comment to establish connection
      controller.enqueue(new TextEncoder().encode(": connected\n\n"));

      for (const message of filteredData) {
        controller.enqueue(new TextEncoder().encode(formatSSEMessage(message.event, message.data)));
      }
      // Always send a complete event to ensure SSE stream properly opens and closes
      if (
        filteredData.length === 0 ||
        !filteredData.some((m) => m.event === "complete" || m.event === "error")
      ) {
        controller.enqueue(
          new TextEncoder().encode(formatSSEMessage("complete", "Logs loaded from database")),
        );
      }
      controller.close();
    },
  });

  return new Response(sseStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
