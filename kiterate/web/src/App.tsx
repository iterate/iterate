import { useCallback, useEffect, useRef, useState } from "react";
import { AgentChat } from "@/components/AgentChat";

interface Event {
  offset: string;
  eventStreamId: string;
  data: unknown;
  createdAt: string;
}

type Tab = "streams" | "agent";

export function App() {
  const [tab, setTab] = useState<Tab>("streams");
  const [streams, setStreams] = useState<string[]>([]);
  const [selectedStream, setSelectedStream] = useState<string>("");
  const [events, setEvents] = useState<Event[]>([]);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [newStreamName, setNewStreamName] = useState("");
  const [newEventData, setNewEventData] = useState("");
  const [agentStreamName, setAgentStreamName] = useState("agent-session");
  const eventSourceRef = useRef<EventSource | null>(null);

  const fetchStreams = useCallback(async () => {
    try {
      const res = await fetch("/api/streams");
      const data = (await res.json()) as { streams: string[] };
      setStreams(data.streams);
    } catch (err) {
      console.error("Failed to fetch streams:", err);
    }
  }, []);

  useEffect(() => {
    fetchStreams();
  }, [fetchStreams]);

  const fetchEvents = useCallback(async (stream: string) => {
    try {
      const res = await fetch(`/api/streams/${stream}/events`);
      const data = (await res.json()) as { events: Event[] };
      setEvents(data.events);
    } catch (err) {
      console.error("Failed to fetch events:", err);
    }
  }, []);

  const handleSelectStream = useCallback(
    (stream: string) => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      setIsSubscribed(false);
      setSelectedStream(stream);
      setEvents([]);
      if (stream) {
        fetchEvents(stream);
      }
    },
    [fetchEvents],
  );

  const handleSubscribe = useCallback(() => {
    if (!selectedStream) return;

    const lastOffset = events.length > 0 ? events[events.length - 1]?.offset : undefined;
    const url = lastOffset
      ? `/api/streams/${selectedStream}/subscribe?offset=${lastOffset}`
      : `/api/streams/${selectedStream}/subscribe`;

    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.addEventListener("event", (e) => {
      try {
        const event = JSON.parse(e.data) as Event;
        setEvents((prev) => [...prev, event]);
      } catch (err) {
        console.error("Failed to parse event:", err);
      }
    });

    eventSource.onerror = () => {
      console.error("EventSource error");
      setIsSubscribed(false);
    };

    setIsSubscribed(true);
  }, [selectedStream, events]);

  const handleUnsubscribe = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setIsSubscribed(false);
  }, []);

  const handleCreateStream = useCallback(async () => {
    if (!newStreamName.trim()) return;

    try {
      await fetch(`/api/streams/${newStreamName}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: { _init: true } }),
      });
      setNewStreamName("");
      fetchStreams();
      handleSelectStream(newStreamName);
    } catch (err) {
      console.error("Failed to create stream:", err);
    }
  }, [newStreamName, fetchStreams, handleSelectStream]);

  const handleAppendEvent = useCallback(async () => {
    if (!selectedStream || !newEventData.trim()) return;

    let parsedData: unknown;
    try {
      parsedData = JSON.parse(newEventData);
    } catch {
      parsedData = newEventData;
    }

    try {
      await fetch(`/api/streams/${selectedStream}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: parsedData }),
      });
      setNewEventData("");
      if (!isSubscribed) {
        fetchEvents(selectedStream);
      }
    } catch (err) {
      console.error("Failed to append event:", err);
    }
  }, [selectedStream, newEventData, isSubscribed, fetchEvents]);

  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      {/* Header */}
      <header className="border-b border-gray-700 p-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">kiterate</h1>
          <div className="flex gap-2">
            <button
              onClick={() => setTab("streams")}
              className={`px-4 py-2 rounded text-sm ${
                tab === "streams" ? "bg-blue-600" : "bg-gray-800 hover:bg-gray-700"
              }`}
            >
              Streams
            </button>
            <button
              onClick={() => setTab("agent")}
              className={`px-4 py-2 rounded text-sm ${
                tab === "agent" ? "bg-blue-600" : "bg-gray-800 hover:bg-gray-700"
              }`}
            >
              Agent Chat
            </button>
          </div>
        </div>
      </header>

      {/* Content */}
      {tab === "streams" ? (
        <div className="flex gap-6 p-4">
          {/* Streams sidebar */}
          <div className="w-64 shrink-0">
            <h2 className="text-lg font-semibold mb-3">Streams</h2>

            <div className="flex gap-2 mb-4">
              <input
                type="text"
                value={newStreamName}
                onChange={(e) => setNewStreamName(e.target.value)}
                placeholder="New stream name"
                className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm"
                onKeyDown={(e) => e.key === "Enter" && handleCreateStream()}
              />
              <button
                onClick={handleCreateStream}
                className="px-3 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm"
              >
                +
              </button>
            </div>

            <div className="space-y-1">
              {streams.map((stream) => (
                <button
                  key={stream}
                  onClick={() => handleSelectStream(stream)}
                  className={`w-full text-left px-3 py-2 rounded text-sm ${
                    selectedStream === stream ? "bg-blue-600" : "bg-gray-800 hover:bg-gray-700"
                  }`}
                >
                  {stream}
                </button>
              ))}
              {streams.length === 0 && <p className="text-gray-500 text-sm">No streams yet</p>}
            </div>
          </div>

          {/* Main content */}
          <div className="flex-1 min-w-0">
            {selectedStream ? (
              <>
                <div className="flex items-center gap-4 mb-4">
                  <h2 className="text-lg font-semibold">{selectedStream}</h2>
                  {isSubscribed ? (
                    <button
                      onClick={handleUnsubscribe}
                      className="px-3 py-1 bg-red-600 hover:bg-red-700 rounded text-sm"
                    >
                      Unsubscribe
                    </button>
                  ) : (
                    <button
                      onClick={handleSubscribe}
                      className="px-3 py-1 bg-green-600 hover:bg-green-700 rounded text-sm"
                    >
                      Subscribe (live)
                    </button>
                  )}
                  {isSubscribed && <span className="text-green-400 text-sm">● Live</span>}
                </div>

                {/* Append event */}
                <div className="flex gap-2 mb-4">
                  <input
                    type="text"
                    value={newEventData}
                    onChange={(e) => setNewEventData(e.target.value)}
                    placeholder='{"key": "value"} or plain text'
                    className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm font-mono"
                    onKeyDown={(e) => e.key === "Enter" && handleAppendEvent()}
                  />
                  <button
                    onClick={handleAppendEvent}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm"
                  >
                    Append
                  </button>
                </div>

                {/* Events list */}
                <div className="bg-gray-800 rounded border border-gray-700 overflow-hidden">
                  <div className="max-h-[600px] overflow-y-auto">
                    {events.length > 0 ? (
                      <table className="w-full text-sm">
                        <thead className="bg-gray-900 sticky top-0">
                          <tr>
                            <th className="px-3 py-2 text-left w-40">Offset</th>
                            <th className="px-3 py-2 text-left">Data</th>
                            <th className="px-3 py-2 text-left w-48">Time</th>
                          </tr>
                        </thead>
                        <tbody>
                          {events.map((event) => (
                            <tr key={event.offset} className="border-t border-gray-700">
                              <td className="px-3 py-2 font-mono text-gray-400">{event.offset}</td>
                              <td className="px-3 py-2 font-mono">{JSON.stringify(event.data)}</td>
                              <td className="px-3 py-2 text-gray-400">
                                {new Date(event.createdAt).toLocaleString()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <p className="px-3 py-4 text-gray-500">No events yet</p>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <p className="text-gray-500">Select a stream to view events</p>
            )}
          </div>
        </div>
      ) : (
        <div className="h-[calc(100vh-73px)]">
          <div className="flex items-center gap-2 p-4 border-b border-gray-700">
            <label className="text-sm text-gray-400">Stream:</label>
            <input
              type="text"
              value={agentStreamName}
              onChange={(e) => setAgentStreamName(e.target.value)}
              className="px-3 py-1 bg-gray-800 border border-gray-700 rounded text-sm"
            />
          </div>
          <div className="h-[calc(100%-57px)]">
            <AgentChat streamName={agentStreamName} />
          </div>
        </div>
      )}
    </div>
  );
}
