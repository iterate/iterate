/**
 * SSE event bus for streaming events to connected viewer UI clients.
 *
 * Uses ReadableStream to push events. Each connected client gets its own
 * stream controller. Broadcasting enqueues to all connected clients.
 */

type SSEClient = {
  controller: ReadableStreamDefaultController<Uint8Array>;
};

const encoder = new TextEncoder();

export type EventBus = {
  /** Broadcast an event to all connected SSE clients. */
  broadcast: (event: string, data: unknown) => void;
  /** Create a new SSE response stream for a client. */
  createStream: () => Response;
  /** Number of connected clients. */
  clientCount: () => number;
};

export function createEventBus(): EventBus {
  const clients = new Set<SSEClient>();

  function broadcast(event: string, data: unknown): void {
    if (clients.size === 0) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const encoded = encoder.encode(payload);
    for (const client of clients) {
      try {
        client.controller.enqueue(encoded);
      } catch {
        clients.delete(client);
      }
    }
  }

  function createStream(): Response {
    let clientRef: SSEClient | null = null;
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        clientRef = { controller };
        clients.add(clientRef);
        // Send initial keepalive comment (not an event, keeps connection open)
        controller.enqueue(encoder.encode(": connected\n\n"));
        // Periodic keepalive every 15s to prevent idle timeouts
        keepaliveTimer = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            if (clientRef) clients.delete(clientRef);
            if (keepaliveTimer) clearInterval(keepaliveTimer);
          }
        }, 15_000);
      },
      cancel() {
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
        if (clientRef) {
          clients.delete(clientRef);
          clientRef = null;
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }

  return {
    broadcast,
    createStream,
    clientCount: () => clients.size,
  };
}
