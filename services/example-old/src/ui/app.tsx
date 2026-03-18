/// <reference lib="dom" />

import { useEffect, useState } from "react";
import { StatusBanner, type StatusTone } from "@iterate-com/ui";
import { Button } from "@iterate-com/ui/components/button";
import { Input } from "@iterate-com/ui/components/input";
import { Label } from "@iterate-com/ui/components/label";

interface ThingRecord {
  id: string;
  thing: string;
  eventId: string;
  createdAt: string;
  updatedAt: string;
}

interface ListThingsResponse {
  things: ThingRecord[];
  total: number;
}

export function App() {
  const [things, setThings] = useState<ThingRecord[]>([]);
  const [thing, setThing] = useState("demo thing");
  const [status, setStatus] = useState("Ready");
  const [tone, setTone] = useState<StatusTone>("neutral");
  const [busy, setBusy] = useState(false);
  const [delayMs, setDelayMs] = useState(1000);
  const [eventType, setEventType] = useState("https://events.iterate.com/example/manual");
  const [streamPath, setStreamPath] = useState("/example/things");

  const loadThings = async () => {
    const res = await fetch("/api/things?limit=20&offset=0");
    if (!res.ok) throw new Error(`List failed (${res.status})`);
    const data = (await res.json()) as ListThingsResponse;
    setThings(data.things);
  };

  useEffect(() => {
    void loadThings();
  }, []);

  const run = async (f: () => Promise<void>, okMessage: string) => {
    setBusy(true);
    try {
      await f();
      setStatus(okMessage);
      setTone("neutral");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      setTone("error");
    } finally {
      setBusy(false);
    }
  };

  const onCreate = async () =>
    await run(async () => {
      const res = await fetch("/api/things", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ thing }),
      });
      if (!res.ok) throw new Error(`Create failed (${res.status})`);
      await loadThings();
    }, "Thing created");

  const onDelete = async (id: string) =>
    await run(async () => {
      const res = await fetch(`/api/things/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Delete failed (${res.status})`);
      await loadThings();
    }, "Thing deleted");

  const onDelayedPublish = async () =>
    await run(async () => {
      const res = await fetch("/api/things/test/delayed-publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          streamPath,
          type: eventType,
          delayMs,
          payload: { source: "example-ui" },
        }),
      });
      if (!res.ok) throw new Error(`Delayed publish failed (${res.status})`);
    }, "Delayed publish scheduled");

  return (
    <main className="mx-auto max-w-md space-y-4 p-4">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">Example</h1>
        <p className="text-xs text-muted-foreground">
          OpenAPI: <code>/api/openapi.json</code> · Docs: <code>/api/docs</code>
        </p>
      </div>

      <div className="space-y-2 rounded-md border p-3">
        <Label>Thing</Label>
        <Input value={thing} onChange={(event) => setThing(event.target.value)} />
        <Button type="button" disabled={busy} onClick={() => void onCreate()}>
          Create
        </Button>
      </div>

      <div className="space-y-2 rounded-md border p-3">
        <Label>Delayed publish</Label>
        <Input value={streamPath} onChange={(event) => setStreamPath(event.target.value)} />
        <Input value={eventType} onChange={(event) => setEventType(event.target.value)} />
        <Input
          type="number"
          min={1}
          value={delayMs}
          onChange={(event) => setDelayMs(Number(event.target.value) || 1)}
        />
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={() => void onDelayedPublish()}
        >
          Schedule
        </Button>
      </div>

      <div className="space-y-2">
        {things.map((item) => (
          <div
            key={item.id}
            className="flex items-center justify-between rounded-md border p-2 text-xs"
          >
            <div>
              <div>{item.thing}</div>
              <div className="text-muted-foreground">{item.id.slice(0, 8)}</div>
            </div>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => void onDelete(item.id)}
            >
              Delete
            </Button>
          </div>
        ))}
      </div>

      <StatusBanner tone={tone}>{status}</StatusBanner>
    </main>
  );
}
