/// <reference lib="dom" />

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  STREAM_CREATED_TYPE,
  STREAM_METADATA_UPDATED_TYPE,
  serviceManifest,
  type StreamEvent,
  type StreamSummary,
} from "@iterate-com/services-contracts/events";
import { IterateEventType } from "@iterate-com/services-contracts/lib";

import { createEventBusClient, createEventBusWebSocketClient } from "../orpc/client.ts";

type StreamTransport = "websocket" | "sse";
type StatusTone = "neutral" | "connected" | "error";

interface ConnectionStatus {
  readonly text: string;
  readonly tone: StatusTone;
}

const DEFAULT_STREAM_PATH = "/demo/stream";
const META_STREAM_PATH = "/events/_meta";
const TRANSPORT_QUERY_PARAM = "transport";

const serviceClientOptions = {
  env: { ITERATE_PROJECT_BASE_URL: location.origin },
  manifest: serviceManifest,
} as const;

const httpClient = createEventBusClient(serviceClientOptions);

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const parseTransport = (value: string): StreamTransport => (value === "sse" ? "sse" : "websocket");

const transportLabel = (transport: StreamTransport): "WS" | "SSE" =>
  transport === "websocket" ? "WS" : "SSE";

const normalizePath = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error("Stream path is required");
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replaceAll(/\/+/g, "/");
};

const isReservedPath = (path: string): boolean =>
  path === "/api" ||
  path.startsWith("/api/") ||
  path.startsWith("/@vite/") ||
  path.startsWith("/@id/") ||
  path.startsWith("/@fs/") ||
  path.startsWith("/node_modules/") ||
  path === "/docs" ||
  path.startsWith("/docs/") ||
  path === "/openapi.json";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    const extra = isRecord(error)
      ? {
          code: error["code"],
          status: error["status"],
        }
      : undefined;

    return [
      error.message,
      ...(typeof extra?.code === "string" ? [`code=${extra.code}`] : []),
      ...(typeof extra?.status === "number" ? [`status=${extra.status}`] : []),
    ].join(" | ");
  }

  return String(error);
};

const parseJsonObject = (
  input: string,
  kind: "Event payload" | "Metadata",
): Record<string, unknown> => {
  const parsed = JSON.parse(input || "{}");
  if (!isRecord(parsed)) {
    throw new Error(`${kind} must be a JSON object`);
  }
  return parsed;
};

const streamPathFromLocation = (): string => {
  const raw = decodeURIComponent(location.pathname);
  if (raw === "/" || raw.trim().length === 0) return DEFAULT_STREAM_PATH;
  return normalizePath(raw);
};

const transportFromLocation = (): StreamTransport => {
  const url = new URL(location.href);
  return parseTransport(url.searchParams.get(TRANSPORT_QUERY_PARAM) ?? "websocket");
};

const setTransportInLocation = (transport: StreamTransport, replace = false): void => {
  const url = new URL(location.href);
  url.searchParams.set(TRANSPORT_QUERY_PARAM, transport);
  const nextURL = `${url.pathname}${url.search}${url.hash}`;
  if (replace) {
    history.replaceState({}, "", nextURL);
    return;
  }
  history.pushState({}, "", nextURL);
};

const setLocationStreamPath = (path: string, replace = false): void => {
  const normalizedPath = normalizePath(path);
  if (isReservedPath(normalizedPath)) {
    throw new Error(`"${normalizedPath}" is reserved for server routes`);
  }
  if (location.pathname === normalizedPath) return;
  const url = new URL(location.href);
  url.pathname = normalizedPath;
  const nextURL = `${url.pathname}${url.search}${url.hash}`;
  if (replace) {
    history.replaceState({}, "", nextURL);
    return;
  }
  history.pushState({}, "", nextURL);
};

const formatRelativeTime = (timestamp: string): string => {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "unknown";

  const deltaSeconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (deltaSeconds < 5) return "just now";
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;

  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;

  const deltaDays = Math.floor(deltaHours / 24);
  return `${deltaDays}d ago`;
};

const extractMetadataFromEvent = (event: StreamEvent): Record<string, unknown> | undefined => {
  if (event.type !== STREAM_METADATA_UPDATED_TYPE) return undefined;
  if (!isRecord(event.payload)) return undefined;
  const metadata = event.payload["metadata"];
  if (!isRecord(metadata)) return undefined;
  return metadata;
};

const extractStreamCreatedPath = (event: StreamEvent): string | undefined => {
  if (event.type !== STREAM_CREATED_TYPE) return undefined;
  if (!isRecord(event.payload)) return undefined;

  const pathValue = event.payload["path"];
  if (typeof pathValue !== "string") return undefined;

  try {
    return normalizePath(pathValue);
  } catch {
    return undefined;
  }
};

const statusToneClass = (tone: StatusTone): string => {
  if (tone === "connected") return "text-emerald-700";
  if (tone === "error") return "text-rose-700";
  return "text-slate-600";
};

const fieldLabelClassName = "block text-xs font-medium text-slate-600";
const inputClassName =
  "mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400";
const textareaClassName =
  "block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400";
const buttonClassName =
  "inline-flex w-full items-center justify-center rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 text-center shadow-sm transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400";
const streamListButtonClassName =
  "w-full rounded-md px-2 py-1.5 text-left transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400";
const sectionHeadingClassName = "mb-3 text-lg font-semibold";

const closeIterator = async (iterator: AsyncIterator<StreamEvent> | undefined): Promise<void> => {
  if (iterator?.return === undefined) return;
  await Promise.race([Promise.resolve(iterator.return()).catch(() => undefined), sleep(250)]);
};

const openLiveIterator = async (
  path: string,
  transport: StreamTransport,
): Promise<{ iterator: AsyncIterator<StreamEvent> }> => {
  if (transport === "websocket") {
    const websocketClient = createEventBusWebSocketClient(serviceClientOptions);
    const stream = await websocketClient.stream({ path, live: true });
    return { iterator: stream[Symbol.asyncIterator]() };
  }

  const stream = await httpClient.stream({ path, live: true });
  return { iterator: stream[Symbol.asyncIterator]() };
};

export function App() {
  const [transport, setTransport] = useState<StreamTransport>("websocket");
  const [selectedStreamPath, setSelectedStreamPath] = useState<string>(DEFAULT_STREAM_PATH);
  const [streamPathInput, setStreamPathInput] = useState<string>(DEFAULT_STREAM_PATH);
  const [streamListState, setStreamListState] = useState<Map<string, StreamSummary>>(
    () => new Map(),
  );
  const [streamSearchInput, setStreamSearchInput] = useState<string>("");
  const [metaStatus, setMetaStatus] = useState<ConnectionStatus>({
    text: `Disconnected via ${transportLabel("websocket")} to ${META_STREAM_PATH}`,
    tone: "neutral",
  });
  const [streamStatus, setStreamStatus] = useState<ConnectionStatus>({
    text: `Disconnected via ${transportLabel("websocket")} to ${DEFAULT_STREAM_PATH}`,
    tone: "neutral",
  });
  const [statusText, setStatusText] = useState<string>("");
  const [statusTone, setStatusTone] = useState<"neutral" | "error">("neutral");
  const [metadataInput, setMetadataInput] = useState<string>("{}");
  const [eventType, setEventType] = useState<string>(
    "https://events.iterate.com/events/ui/manual-event-appended",
  );
  const [eventPayload, setEventPayload] = useState<string>('{"message":"hello"}');
  const [events, setEvents] = useState<StreamEvent[]>([]);

  const transportRef = useRef<StreamTransport>("websocket");
  const selectedStreamPathRef = useRef<string>(DEFAULT_STREAM_PATH);
  const knownStreamsRef = useRef<Map<string, StreamSummary>>(new Map());
  const metadataTokenRef = useRef<number>(0);
  const metadataIteratorRef = useRef<AsyncIterator<StreamEvent> | undefined>(undefined);
  const metadataReconnectTimerRef = useRef<number | undefined>(undefined);
  const streamTokenRef = useRef<number>(0);
  const streamIteratorRef = useRef<AsyncIterator<StreamEvent> | undefined>(undefined);
  const openStreamPathRef = useRef<string | undefined>(undefined);
  const refreshIntervalRef = useRef<number | undefined>(undefined);

  const setStatus = useCallback((message: string, isError = false): void => {
    setStatusText(message);
    setStatusTone(isError ? "error" : "neutral");
  }, []);

  const setKnownStreams = useCallback((nextMap: Map<string, StreamSummary>): void => {
    knownStreamsRef.current = nextMap;
    setStreamListState(new Map(nextMap));
  }, []);

  const ensureKnownStream = useCallback(
    (path: string): void => {
      const current = knownStreamsRef.current;
      if (current.has(path)) return;
      const now = new Date().toISOString();
      const next = new Map(current);
      next.set(path, {
        path,
        createdAt: now,
        eventCount: 0,
        lastEventCreatedAt: now,
        metadata: {},
      });
      setKnownStreams(next);
    },
    [setKnownStreams],
  );

  const applySelectedStreamMetadata = useCallback((): void => {
    const summary = knownStreamsRef.current.get(selectedStreamPathRef.current);
    if (summary === undefined) {
      setMetadataInput("{}");
      return;
    }
    setMetadataInput(JSON.stringify(summary.metadata, null, 2));
  }, []);

  const refreshStreams = useCallback(async (): Promise<void> => {
    const summaries = await httpClient.listStreams({});

    const next = new Map<string, StreamSummary>();
    for (const summary of summaries) {
      let normalizedPath: string;
      try {
        normalizedPath = normalizePath(summary.path);
      } catch {
        continue;
      }

      next.set(normalizedPath, {
        ...summary,
        path: normalizedPath,
        metadata: isRecord(summary.metadata) ? summary.metadata : {},
      });
    }

    if (!next.has(selectedStreamPathRef.current)) {
      const now = new Date().toISOString();
      next.set(selectedStreamPathRef.current, {
        path: selectedStreamPathRef.current,
        createdAt: now,
        eventCount: 0,
        lastEventCreatedAt: now,
        metadata: {},
      });
    }

    setKnownStreams(next);
    applySelectedStreamMetadata();
  }, [applySelectedStreamMetadata, setKnownStreams]);

  const updateStreamSummaryFromEvent = useCallback(
    (event: StreamEvent): void => {
      let path: string;
      try {
        path = normalizePath(event.path);
      } catch {
        return;
      }

      const previous = knownStreamsRef.current.get(path);
      const metadata = extractMetadataFromEvent(event) ?? previous?.metadata ?? {};
      const createdAt = previous?.createdAt ?? event.createdAt;
      const eventCount = (previous?.eventCount ?? 0) + 1;

      const next = new Map(knownStreamsRef.current);
      next.set(path, {
        path,
        createdAt,
        eventCount,
        lastEventCreatedAt: event.createdAt,
        metadata,
      });
      setKnownStreams(next);

      if (path === selectedStreamPathRef.current) {
        setMetadataInput(JSON.stringify(metadata, null, 2));
      }
    },
    [setKnownStreams],
  );

  const clearMetadataReconnectTimer = useCallback((): void => {
    if (metadataReconnectTimerRef.current !== undefined) {
      clearTimeout(metadataReconnectTimerRef.current);
      metadataReconnectTimerRef.current = undefined;
    }
  }, []);

  const disconnectMetadata = useCallback(async (): Promise<void> => {
    metadataTokenRef.current += 1;
    clearMetadataReconnectTimer();

    const iterator = metadataIteratorRef.current;
    metadataIteratorRef.current = undefined;

    await closeIterator(iterator);

    setMetaStatus({
      text: `Disconnected via ${transportLabel(transportRef.current)} to ${META_STREAM_PATH}`,
      tone: "neutral",
    });
  }, [clearMetadataReconnectTimer]);

  const disconnectStream = useCallback(async (): Promise<void> => {
    streamTokenRef.current += 1;

    const iterator = streamIteratorRef.current;
    streamIteratorRef.current = undefined;
    openStreamPathRef.current = undefined;

    await closeIterator(iterator);

    setStreamStatus({
      text: `Disconnected via ${transportLabel(transportRef.current)} to ${selectedStreamPathRef.current}`,
      tone: "neutral",
    });
  }, []);

  const connectMetadata = useCallback(async (): Promise<void> => {
    await disconnectMetadata();

    const token = metadataTokenRef.current + 1;
    metadataTokenRef.current = token;

    const currentTransport = transportRef.current;
    setMetaStatus({
      text: `Connecting via ${transportLabel(currentTransport)} to ${META_STREAM_PATH}`,
      tone: "neutral",
    });

    const scheduleReconnect = (): void => {
      clearMetadataReconnectTimer();
      metadataReconnectTimerRef.current = window.setTimeout(() => {
        void connectMetadata();
      }, 1_000);
    };

    try {
      const opened = await openLiveIterator(META_STREAM_PATH, currentTransport);
      metadataIteratorRef.current = opened.iterator;

      setMetaStatus({
        text: `Connected via ${transportLabel(currentTransport)} to ${META_STREAM_PATH}`,
        tone: "connected",
      });
      setStatus("");

      void refreshStreams().catch(() => undefined);

      void (async () => {
        try {
          while (token === metadataTokenRef.current) {
            const next = await opened.iterator.next();
            if (next.done) break;

            const createdPath = extractStreamCreatedPath(next.value);
            if (createdPath !== undefined) {
              ensureKnownStream(createdPath);
            }

            updateStreamSummaryFromEvent(next.value);
            void refreshStreams().catch(() => undefined);
          }

          if (token === metadataTokenRef.current) {
            setMetaStatus({
              text: `Connection closed via ${transportLabel(currentTransport)} to ${META_STREAM_PATH}`,
              tone: "error",
            });
            scheduleReconnect();
          }
        } catch (error) {
          if (token !== metadataTokenRef.current) return;
          setMetaStatus({
            text: `Connection error via ${transportLabel(currentTransport)} to ${META_STREAM_PATH}`,
            tone: "error",
          });
          setStatus(`Metadata stream error: ${errorMessage(error)}`, true);
          scheduleReconnect();
        }
      })();
    } catch (error) {
      setMetaStatus({
        text: `Connection error via ${transportLabel(currentTransport)} to ${META_STREAM_PATH}`,
        tone: "error",
      });
      setStatus(`Metadata stream error: ${errorMessage(error)}`, true);
      scheduleReconnect();
    }
  }, [
    clearMetadataReconnectTimer,
    disconnectMetadata,
    ensureKnownStream,
    refreshStreams,
    setStatus,
    updateStreamSummaryFromEvent,
  ]);

  const connectStream = useCallback(
    async (
      streamPath: string,
      options: { readonly syncHistory: boolean; readonly replaceHistory?: boolean } = {
        syncHistory: true,
      },
    ): Promise<void> => {
      const normalizedPath = normalizePath(streamPath);
      if (isReservedPath(normalizedPath)) {
        throw new Error(`"${normalizedPath}" is reserved for server routes`);
      }

      selectedStreamPathRef.current = normalizedPath;
      setSelectedStreamPath(normalizedPath);
      setStreamPathInput(normalizedPath);

      if (options.syncHistory) {
        setLocationStreamPath(normalizedPath, options.replaceHistory === true);
      }

      await disconnectStream();
      setEvents([]);
      ensureKnownStream(normalizedPath);
      applySelectedStreamMetadata();

      const token = streamTokenRef.current + 1;
      streamTokenRef.current = token;

      const currentTransport = transportRef.current;
      setStreamStatus({
        text: `Connecting via ${transportLabel(currentTransport)} to ${normalizedPath}`,
        tone: "neutral",
      });

      try {
        const opened = await openLiveIterator(normalizedPath, currentTransport);
        streamIteratorRef.current = opened.iterator;
        openStreamPathRef.current = normalizedPath;

        setStreamStatus({
          text: `Connected via ${transportLabel(currentTransport)} to ${normalizedPath}`,
          tone: "connected",
        });
        setStatus("");

        void (async () => {
          try {
            while (token === streamTokenRef.current) {
              const next = await opened.iterator.next();
              if (next.done) break;
              setEvents((previous) => [next.value, ...previous].slice(0, 200));
              updateStreamSummaryFromEvent(next.value);
            }

            if (token === streamTokenRef.current) {
              openStreamPathRef.current = undefined;
              setStreamStatus({
                text: `Connection closed via ${transportLabel(currentTransport)} to ${normalizedPath}`,
                tone: "error",
              });
            }
          } catch (error) {
            if (token === streamTokenRef.current) {
              openStreamPathRef.current = undefined;
              setStreamStatus({
                text: `Connection error via ${transportLabel(currentTransport)} to ${normalizedPath}`,
                tone: "error",
              });
              setStatus(`Stream error: ${errorMessage(error)}`, true);
            }
          }
        })();

        await refreshStreams();
      } catch (error) {
        openStreamPathRef.current = undefined;
        setStreamStatus({
          text: `Connection error via ${transportLabel(currentTransport)} to ${normalizedPath}`,
          tone: "error",
        });
        setStatus(errorMessage(error), true);
      }
    },
    [
      applySelectedStreamMetadata,
      disconnectStream,
      ensureKnownStream,
      refreshStreams,
      setStatus,
      updateStreamSummaryFromEvent,
    ],
  );

  const reconnectAll = useCallback(async (): Promise<void> => {
    await connectMetadata();
    await connectStream(selectedStreamPathRef.current, { syncHistory: false });
  }, [connectMetadata, connectStream]);

  const sortedStreams = useMemo(() => {
    return [...streamListState.values()].sort(
      (left, right) =>
        right.lastEventCreatedAt.localeCompare(left.lastEventCreatedAt) ||
        left.path.localeCompare(right.path),
    );
  }, [streamListState]);

  const filteredStreams = useMemo(() => {
    const query = streamSearchInput.trim().toLowerCase();
    if (query.length === 0) return sortedStreams;
    return sortedStreams.filter((stream) => JSON.stringify(stream).toLowerCase().includes(query));
  }, [sortedStreams, streamSearchInput]);

  const onOpenStream = useCallback(async (): Promise<void> => {
    await connectStream(streamPathInput, { syncHistory: true });
  }, [connectStream, streamPathInput]);

  const onTransportChange = useCallback(
    async (nextTransport: StreamTransport): Promise<void> => {
      transportRef.current = nextTransport;
      setTransport(nextTransport);
      setTransportInLocation(nextTransport, true);
      await reconnectAll();
      setStatus("");
    },
    [reconnectAll, setStatus],
  );

  const onAppendEvent = useCallback(async (): Promise<void> => {
    const path = normalizePath(streamPathInput);
    const trimmedType = eventType.trim();
    if (trimmedType.length === 0) throw new Error("Event type is required");
    const parsedType = IterateEventType.parse(trimmedType);

    const payload = parseJsonObject(eventPayload, "Event payload");

    if (openStreamPathRef.current !== path) {
      await connectStream(path, { syncHistory: true });
    }

    await httpClient.append({
      path,
      events: [{ type: parsedType, payload }],
    });

    setStatus("");
  }, [connectStream, eventPayload, eventType, setStatus, streamPathInput]);

  const onSetMetadata = useCallback(async (): Promise<void> => {
    const path = normalizePath(streamPathInput);
    const parsed = parseJsonObject(metadataInput, "Metadata");

    if (openStreamPathRef.current !== path) {
      await connectStream(path, { syncHistory: true });
    }

    await httpClient.append({
      path,
      events: [
        {
          type: STREAM_METADATA_UPDATED_TYPE,
          payload: { metadata: parsed },
        },
      ],
    });

    setMetadataInput(JSON.stringify(parsed, null, 2));
    setStatus("");
    await refreshStreams();
  }, [connectStream, metadataInput, refreshStreams, setStatus, streamPathInput]);

  useEffect(() => {
    let disposed = false;

    const setup = async (): Promise<void> => {
      try {
        const initialTransport = transportFromLocation();
        transportRef.current = initialTransport;
        setTransport(initialTransport);
        setTransportInLocation(initialTransport, true);
        const locationPath = streamPathFromLocation();
        selectedStreamPathRef.current = locationPath;
        setSelectedStreamPath(locationPath);
        setStreamPathInput(locationPath);
        setMetadataInput("{}");
        setMetaStatus({
          text: `Connecting via ${transportLabel(initialTransport)} to ${META_STREAM_PATH}`,
          tone: "neutral",
        });
        setStreamStatus({
          text: `Disconnected via ${transportLabel(initialTransport)} to ${locationPath}`,
          tone: "neutral",
        });

        ensureKnownStream(locationPath);
        await refreshStreams();
        void connectMetadata();

        if (disposed) return;

        if (location.pathname === "/") {
          await connectStream(locationPath, { syncHistory: true, replaceHistory: true });
        } else {
          await connectStream(locationPath, { syncHistory: false });
        }
      } catch (error) {
        setStatus(errorMessage(error), true);
      }
    };

    const onPopState = (): void => {
      void (async () => {
        try {
          const locationTransport = transportFromLocation();
          if (locationTransport !== transportRef.current) {
            transportRef.current = locationTransport;
            setTransport(locationTransport);
            await connectMetadata();
          }
          await connectStream(streamPathFromLocation(), { syncHistory: false });
        } catch (error) {
          setStatus(errorMessage(error), true);
        }
      })();
    };

    window.addEventListener("popstate", onPopState);

    refreshIntervalRef.current = window.setInterval(() => {
      void refreshStreams().catch(() => undefined);
    }, 5_000);

    void setup();

    return () => {
      disposed = true;
      window.removeEventListener("popstate", onPopState);
      if (refreshIntervalRef.current !== undefined) {
        clearInterval(refreshIntervalRef.current);
        refreshIntervalRef.current = undefined;
      }
      void disconnectMetadata();
      void disconnectStream();
      if (metadataReconnectTimerRef.current !== undefined) {
        clearTimeout(metadataReconnectTimerRef.current);
        metadataReconnectTimerRef.current = undefined;
      }
    };
  }, [
    connectMetadata,
    connectStream,
    disconnectMetadata,
    disconnectStream,
    ensureKnownStream,
    refreshStreams,
    setStatus,
  ]);

  return (
    <main className="mx-auto grid max-w-6xl gap-5 p-4 md:grid-cols-[19rem_1fr]">
      <section className="flex min-h-[26rem] flex-col gap-4">
        <div>
          <p className={`text-xs ${statusToneClass(metaStatus.tone)}`}>{metaStatus.text}</p>

          <div className="mt-4 space-y-3">
            <label className={fieldLabelClassName}>
              Connect via
              <select
                value={transport}
                className={inputClassName}
                onChange={(event) => {
                  const nextTransport = parseTransport(event.currentTarget.value);
                  void onTransportChange(nextTransport).catch((error) => {
                    setStatus(errorMessage(error), true);
                  });
                }}
              >
                <option value="websocket">WebSocket</option>
                <option value="sse">SSE</option>
              </select>
            </label>

            <label className={fieldLabelClassName}>
              Connect to stream
              <input
                value={streamPathInput}
                className={inputClassName}
                onChange={(event) => {
                  setStreamPathInput(event.currentTarget.value);
                }}
              />
            </label>

            <button
              type="button"
              className={buttonClassName}
              onClick={() => {
                void onOpenStream().catch((error) => {
                  setStatus(errorMessage(error), true);
                });
              }}
            >
              Open Stream
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1">
          <h2 className={sectionHeadingClassName}>Streams</h2>
          <input
            value={streamSearchInput}
            placeholder="Search streams (path, metadata, stats)"
            className={inputClassName}
            onChange={(event) => {
              setStreamSearchInput(event.currentTarget.value);
            }}
          />

          <ul className="mt-3 space-y-2 overflow-y-auto">
            {filteredStreams.length === 0 ? (
              <li className="py-2 text-xs text-slate-500">No streams yet</li>
            ) : (
              filteredStreams.map((stream) => (
                <li key={stream.path}>
                  <button
                    type="button"
                    className={streamListButtonClassName}
                    onClick={() => {
                      void connectStream(stream.path, { syncHistory: true }).catch((error) => {
                        setStatus(errorMessage(error), true);
                      });
                    }}
                  >
                    <div
                      className={`truncate text-xs ${
                        stream.path === selectedStreamPath
                          ? "font-semibold text-slate-900"
                          : "text-slate-700"
                      }`}
                    >
                      {stream.path}
                    </div>
                    <div className="mt-1 text-[11px] text-slate-500">
                      {stream.eventCount} event{stream.eventCount === 1 ? "" : "s"} · updated{" "}
                      {formatRelativeTime(stream.lastEventCreatedAt)}
                    </div>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <p className={`text-xs ${statusToneClass(streamStatus.tone)}`}>{streamStatus.text}</p>
          {statusTone === "error" && statusText.length > 0 ? (
            <p className="mt-2 text-xs text-rose-600">{statusText}</p>
          ) : null}
        </div>

        <div>
          <h2 className={sectionHeadingClassName}>Stream Metadata</h2>
          <textarea
            rows={4}
            className={textareaClassName}
            value={metadataInput}
            onChange={(event) => {
              setMetadataInput(event.currentTarget.value);
            }}
          />
          <button
            type="button"
            className={`mt-2 ${buttonClassName}`}
            onClick={() => {
              void onSetMetadata().catch((error) => {
                setStatus(errorMessage(error), true);
              });
            }}
          >
            Update Metadata
          </button>
        </div>

        <div>
          <h2 className={sectionHeadingClassName}>Append Event</h2>
          <div className="grid gap-2">
            <input
              value={eventType}
              className={inputClassName}
              onChange={(event) => {
                setEventType(event.currentTarget.value);
              }}
            />
            <textarea
              rows={4}
              className={textareaClassName}
              value={eventPayload}
              onChange={(event) => {
                setEventPayload(event.currentTarget.value);
              }}
            />
            <button
              type="button"
              className={buttonClassName}
              onClick={() => {
                void onAppendEvent().catch((error) => {
                  setStatus(errorMessage(error), true);
                });
              }}
            >
              Send JSON Event
            </button>
          </div>
        </div>

        <div>
          <h2 className={sectionHeadingClassName}>Live Events</h2>
          <ul className="divide-y divide-slate-200">
            {events.length === 0 ? (
              <li className="py-2 text-xs text-slate-500">No live events yet</li>
            ) : null}
            {events.map((event) => (
              <li key={`${event.path}:${event.offset}`} className="py-2">
                <details className="group">
                  <summary
                    className="flex w-full list-none cursor-pointer items-center gap-3 py-1 text-xs [&::-webkit-details-marker]:hidden"
                    aria-label={`Toggle raw data for ${event.type} at offset ${event.offset}`}
                  >
                    <span className="min-w-0 truncate text-slate-800">{event.type}</span>
                    <span className="ml-auto flex flex-col items-end text-right">
                      <span className="font-mono text-slate-700">{event.offset}</span>
                      <span className="text-slate-500" title={event.createdAt}>
                        {formatRelativeTime(event.createdAt)}
                      </span>
                    </span>
                    <span className="text-slate-500 transition-transform group-open:rotate-90">
                      ▸
                    </span>
                  </summary>
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words text-xs text-slate-800">
                    {JSON.stringify(event, null, 2) ?? "null"}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </main>
  );
}
