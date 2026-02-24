/// <reference lib="dom" />

import { useEffect, useMemo, useState } from "react";

interface EventRecord {
  readonly id: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ListEventsResponse {
  readonly events: EventRecord[];
  readonly total: number;
}

const defaultPayload = '{\n  "source": "events-ui"\n}';

const parseJsonObject = (raw: string): Record<string, unknown> => {
  const parsed = JSON.parse(raw || "{}");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Payload must be a JSON object");
  }
  return parsed as Record<string, unknown>;
};

const formatTime = (value: string) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
};

export function App() {
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [type, setType] = useState("manual-event");
  const [payloadInput, setPayloadInput] = useState(defaultPayload);
  const [status, setStatus] = useState("Ready");
  const [statusTone, setStatusTone] = useState<"neutral" | "error">("neutral");
  const [busy, setBusy] = useState(false);
  const [selectedEventId, setSelectedEventId] = useState<string>("");
  const [updateType, setUpdateType] = useState("");

  const selectedEvent = useMemo(
    () => events.find((event) => event.id === selectedEventId),
    [events, selectedEventId],
  );

  const setError = (message: string) => {
    setStatus(message);
    setStatusTone("error");
  };

  const setInfo = (message: string) => {
    setStatus(message);
    setStatusTone("neutral");
  };

  const loadEvents = async () => {
    const response = await fetch("/api/events?limit=25&offset=0");
    if (!response.ok) {
      throw new Error(`Failed to list events (${response.status})`);
    }
    const data = (await response.json()) as ListEventsResponse;
    setEvents(data.events);
    if (data.events.length > 0 && !selectedEventId) {
      setSelectedEventId(data.events[0].id);
      setUpdateType(data.events[0].type);
    }
    return data.events.length;
  };

  const refresh = async () => {
    setBusy(true);
    try {
      const count = await loadEvents();
      setInfo(`Loaded ${String(count)} event(s)`);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const onCreate = async () => {
    setBusy(true);
    try {
      const payload = parseJsonObject(payloadInput);
      const response = await fetch("/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type, payload }),
      });
      if (!response.ok) {
        throw new Error(`Failed to create event (${response.status})`);
      }
      const created = (await response.json()) as EventRecord;
      setSelectedEventId(created.id);
      setUpdateType(created.type);
      await loadEvents();
      setInfo(`Created event ${created.id}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const onUpdate = async () => {
    if (!selectedEventId) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(selectedEventId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: updateType }),
      });
      if (!response.ok) {
        throw new Error(`Failed to update event (${response.status})`);
      }
      await loadEvents();
      setInfo(`Updated event ${selectedEventId}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    if (!selectedEventId) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(selectedEventId)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(`Failed to delete event (${response.status})`);
      }
      setSelectedEventId("");
      setUpdateType("");
      await loadEvents();
      setInfo("Deleted event");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!selectedEvent) return;
    setUpdateType(selectedEvent.type);
  }, [selectedEvent]);

  return (
    <main className="mx-auto grid min-h-screen w-full max-w-6xl gap-6 p-4 md:grid-cols-[2fr_1fr]">
      <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Events Service</h1>
          <button
            className="rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50"
            disabled={busy}
            onClick={() => void refresh()}
            type="button"
          >
            Refresh
          </button>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <label className="block text-sm">
            <span className="text-slate-600">Event type</span>
            <input
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
              onChange={(event) => setType(event.target.value)}
              value={type}
            />
          </label>
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
            OpenAPI: <code>/api/openapi.json</code>
            <br />
            Scalar: <code>/api/docs</code>
          </div>
        </div>

        <label className="block text-sm">
          <span className="text-slate-600">Payload (JSON object)</span>
          <textarea
            className="mt-1 min-h-32 w-full rounded-md border border-slate-300 p-3 font-mono text-xs"
            onChange={(event) => setPayloadInput(event.target.value)}
            value={payloadInput}
          />
        </label>

        <div className="flex gap-2">
          <button
            className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
            disabled={busy}
            onClick={() => void onCreate()}
            type="button"
          >
            Create event
          </button>
        </div>

        <div
          className={`rounded-md border px-3 py-2 text-sm ${
            statusTone === "error"
              ? "border-rose-300 bg-rose-50 text-rose-800"
              : "border-slate-200 bg-slate-50 text-slate-700"
          }`}
        >
          {status}
        </div>
      </section>

      <aside className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Recent Events
        </h2>
        <div className="max-h-[60vh] space-y-2 overflow-auto">
          {events.map((event) => (
            <button
              className={`w-full rounded-md border px-3 py-2 text-left text-xs ${
                selectedEventId === event.id
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 hover:bg-slate-50"
              }`}
              key={event.id}
              onClick={() => setSelectedEventId(event.id)}
              type="button"
            >
              <div className="font-mono">{event.id.slice(0, 8)}</div>
              <div className={selectedEventId === event.id ? "text-slate-200" : "text-slate-600"}>
                {event.type}
              </div>
            </button>
          ))}
          {events.length === 0 ? <p className="text-sm text-slate-500">No events yet.</p> : null}
        </div>

        {selectedEvent ? (
          <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs">
            <p className="font-mono text-[11px]">{selectedEvent.id}</p>
            <p>Created: {formatTime(selectedEvent.createdAt)}</p>
            <p>Updated: {formatTime(selectedEvent.updatedAt)}</p>
            <label className="block">
              <span className="text-slate-600">Update type</span>
              <input
                className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1"
                onChange={(event) => setUpdateType(event.target.value)}
                value={updateType}
              />
            </label>
            <div className="flex gap-2">
              <button
                className="rounded-md border border-slate-300 px-2 py-1 hover:bg-slate-100"
                disabled={busy}
                onClick={() => void onUpdate()}
                type="button"
              >
                Patch
              </button>
              <button
                className="rounded-md border border-rose-300 px-2 py-1 text-rose-700 hover:bg-rose-50"
                disabled={busy}
                onClick={() => void onDelete()}
                type="button"
              >
                Delete
              </button>
            </div>
          </div>
        ) : null}
      </aside>
    </main>
  );
}
