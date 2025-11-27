import dedent from "dedent";

type SSEMessage = {
  event: string;
  data: string;
};

// Custom implemented sse stream helper
// waiting on https://github.com/honojs/hono/pull/4543 to just use hono's streamSSE helper
export function intoImmediateSSEResponse(data: SSEMessage[]) {
  const sseStream = new ReadableStream({
    start(controller) {
      for (const message of data) {
        controller.enqueue(
          new TextEncoder().encode(dedent`
            event: ${message.event}
            ${message.data
              .split("\n")
              .map((line: string) => `data: ${line}`)
              .join("\n")}
            \n
          `),
        );
      }
      controller.close();
    },
    type: "bytes",
  });

  return new Response(sseStream, {
    headers: {
      "Content-Type": "text/event-stream",
    },
  });
}
