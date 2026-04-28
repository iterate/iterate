import { useEffect, useRef, useState } from "react";
import type { Event, StreamPath } from "@iterate-com/events-contract";

/** Client-side cap for live stream events; older rows are dropped to bound memory and projection work. */
const LIVE_STREAM_MAX_EVENTS = 50_000;

/** Fails the subscription if the stream handshake never finishes (e.g. proxy/worker dev quirks). */
const LIVE_STREAM_CONNECT_TIMEOUT_MS = 45_000;

export function useLiveStreamEvents({
  streamPath,
  onEvent,
  maxEvents = LIVE_STREAM_MAX_EVENTS,
}: {
  streamPath: StreamPath;
  onEvent?: (event: Event) => void;
  maxEvents?: number;
}) {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const [events, setEvents] = useState<Event[]>([]);
  const [status, setStatus] = useState(`Connecting to ${streamPath}`);
  const [isConnecting, setIsConnecting] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    let isCurrent = true;
    let pendingEvents: Event[] = [];
    let flushEventsTimeout: ReturnType<typeof setTimeout> | undefined;
    const connectTimeout = setTimeout(() => {
      if (!isCurrent) return;
      controller.abort();
      setStatus(
        `Timed out after ${LIVE_STREAM_CONNECT_TIMEOUT_MS / 1000}s — live stream did not start. Check the network tab for /api and that the events worker is running.`,
      );
      setIsConnecting(false);
    }, LIVE_STREAM_CONNECT_TIMEOUT_MS);

    setEvents([]);
    setStatus(`Connecting to ${streamPath}`);
    setIsConnecting(true);

    const clearConnectTimeout = () => {
      clearTimeout(connectTimeout);
    };
    const flushPendingEvents = () => {
      flushEventsTimeout = undefined;
      if (!isCurrent || pendingEvents.length === 0) {
        pendingEvents = [];
        return;
      }

      const eventsToAppend = pendingEvents;
      pendingEvents = [];
      setEvents((previous) => {
        const next = [...previous, ...eventsToAppend];
        return next.length > maxEvents ? next.slice(-maxEvents) : next;
      });
    };
    const queueEvent = (event: Event) => {
      pendingEvents.push(event);
      flushEventsTimeout ??= setTimeout(flushPendingEvents, 0);
    };

    void (async () => {
      try {
        const response = await fetch(buildStreamApiUrl(streamPath), {
          headers: { accept: "text/event-stream" },
          signal: controller.signal,
        });

        if (!isCurrent || controller.signal.aborted) {
          setIsConnecting(false);
          return;
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }

        if (response.body == null) {
          throw new Error("Stream response had no body.");
        }

        clearConnectTimeout();
        setStatus(`Streaming ${streamPath}`);
        setIsConnecting(false);

        for await (const event of decodeServerSentEvents(response.body)) {
          if (!isCurrent || controller.signal.aborted) {
            return;
          }

          onEventRef.current?.(event);
          queueEvent(event);
        }

        if (!isCurrent || controller.signal.aborted) {
          return;
        }

        flushPendingEvents();
        setStatus(`Closed ${streamPath}`);
        setIsConnecting(false);
      } catch (error) {
        clearConnectTimeout();
        if (controller.signal.aborted) {
          if (isCurrent) {
            setIsConnecting(false);
          }
          return;
        }
        if (!isCurrent) {
          return;
        }
        setStatus(`Error: ${readErrorMessage(error)}`);
        setIsConnecting(false);
      }
    })();

    return () => {
      isCurrent = false;
      clearConnectTimeout();
      if (flushEventsTimeout != null) {
        clearTimeout(flushEventsTimeout);
      }
      pendingEvents = [];
      controller.abort();
    };
  }, [maxEvents, streamPath]);

  return {
    events,
    isConnecting,
    status,
  };
}

function readErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function buildStreamApiUrl(streamPath: StreamPath) {
  const path = streamPath === "/" ? "%2F" : streamPath.replace(/^\/+/, "");
  return `/api/streams/${path}`;
}

async function* decodeServerSentEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<Event> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });
      }

      let frameBoundary = findSseFrameBoundary(buffer);
      while (frameBoundary !== -1) {
        const frame = buffer.slice(0, frameBoundary);
        const separatorLength = buffer.startsWith("\r\n\r\n", frameBoundary) ? 4 : 2;
        buffer = buffer.slice(frameBoundary + separatorLength);
        const event = decodeSseFrame(frame);
        if (event) {
          yield event;
        }
        frameBoundary = findSseFrameBoundary(buffer);
      }

      if (done) {
        buffer += decoder.decode();
        if (buffer.trim().length > 0) {
          const event = decodeSseFrame(buffer);
          if (event) {
            yield event;
          }
        }
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function findSseFrameBoundary(buffer: string) {
  const lfBoundary = buffer.indexOf("\n\n");
  const crlfBoundary = buffer.indexOf("\r\n\r\n");
  if (lfBoundary === -1) return crlfBoundary;
  if (crlfBoundary === -1) return lfBoundary;
  return Math.min(lfBoundary, crlfBoundary);
}

function decodeSseFrame(frame: string): Event | null {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");

  if (data.length === 0) {
    return null;
  }

  try {
    return JSON.parse(data) as Event;
  } catch (error) {
    console.warn("[events] skipping malformed SSE event frame", { error, frame });
    return null;
  }
}
