import { useEffect, useState } from "react";
import type { Event, StreamPath } from "@iterate-com/events-contract";
import { orpcClient } from "~/orpc/client.ts";

export function useLiveStreamEvents({
  streamPath,
  onEvent,
  maxEvents = 200,
}: {
  streamPath: StreamPath;
  onEvent?: (event: Event) => void;
  maxEvents?: number;
}) {
  const [events, setEvents] = useState<Event[]>([]);
  const [status, setStatus] = useState(`Connecting to ${streamPath}`);
  const [isConnecting, setIsConnecting] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    let isCurrent = true;
    let iterator: AsyncIterator<Event> | undefined;

    setEvents([]);
    setStatus(`Connecting to ${streamPath}`);
    setIsConnecting(true);

    void (async () => {
      try {
        const stream = await orpcClient.stream(
          {
            path: streamPath,
            live: true,
          },
          { signal: controller.signal },
        );

        iterator = stream[Symbol.asyncIterator]();

        if (!isCurrent || controller.signal.aborted) {
          return;
        }

        setStatus(`Streaming ${streamPath}`);
        setIsConnecting(false);

        for await (const event of stream) {
          if (!isCurrent || controller.signal.aborted) {
            return;
          }

          onEvent?.(event);
          setEvents((previous) => {
            const next = [...previous, event];
            return next.length > maxEvents ? next.slice(-maxEvents) : next;
          });
        }

        if (!isCurrent || controller.signal.aborted) {
          return;
        }

        setStatus(`Closed ${streamPath}`);
        setIsConnecting(false);
      } catch (error) {
        if (!isCurrent || controller.signal.aborted) {
          return;
        }

        setStatus(`Error: ${readErrorMessage(error)}`);
        setIsConnecting(false);
      }
    })();

    return () => {
      isCurrent = false;
      controller.abort();
      void iterator?.return?.();
    };
  }, [maxEvents, onEvent, streamPath]);

  return {
    events,
    isConnecting,
    status,
  };
}

function readErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
