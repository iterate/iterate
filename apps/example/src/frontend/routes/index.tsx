import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import confetti from "canvas-confetti";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@iterate-com/ui/components/button";
import { Input } from "@iterate-com/ui/components/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/card";
import { orpc } from "@/frontend/lib/orpc.ts";

export const Route = createFileRoute("/")({
  component: IndexPage,
});

function getWebSocketBaseUrl() {
  const baseUrl =
    import.meta.env.VITE_API_BASE_URL?.trim() ||
    (typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:17402");
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function PingPongDemo({ wsBase }: { wsBase: string }) {
  const [status, setStatus] = useState<"disconnected" | "connected" | "waiting">("disconnected");
  const [lastPong, setLastPong] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const connect = useCallback(() => {
    const ws = new WebSocket(`${wsBase}/api/ping/ws`);
    wsRef.current = ws;
    ws.onopen = () => setStatus("connected");
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data as string) as { type: string; ts: number };
      if (data.type === "pong") {
        setLastPong(new Date(data.ts).toLocaleTimeString());
        setStatus("connected");
      }
    };
    ws.onclose = () => setStatus("disconnected");
  }, [wsBase]);

  const sendPing = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send("ping");
      setStatus("waiting");
    }
  }, []);

  useEffect(() => {
    return () => wsRef.current?.close();
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">WebSocket Ping-Pong</CardTitle>
        <CardDescription>
          {status === "disconnected" && "Not connected"}
          {status === "connected" && "Connected — send a ping"}
          {status === "waiting" && "Waiting for pong (1s delay)..."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {status === "disconnected" ? (
          <Button size="sm" onClick={connect}>
            Connect
          </Button>
        ) : (
          <Button size="sm" onClick={sendPing} disabled={status === "waiting"}>
            Send Ping
          </Button>
        )}
        {lastPong && <p className="text-xs text-muted-foreground">Last pong: {lastPong}</p>}
      </CardContent>
    </Card>
  );
}

function ConfettiDemo({ wsBase }: { wsBase: string }) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);

  const connect = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return;
    const ws = new WebSocket(`${wsBase}/api/confetti/ws`);
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data as string) as { type: string; x: number; y: number };
      if (data.type === "boom") {
        void confetti({ particleCount: 40, origin: { x: data.x, y: data.y }, spread: 55 });
      }
    };
    ws.onclose = () => {
      wsRef.current = null;
      setConnected(false);
    };
  }, [wsBase]);

  const launch = useCallback(
    (event: React.MouseEvent) => {
      if (!connected) {
        connect();
        return;
      }
      if (wsRef.current?.readyState !== WebSocket.OPEN) return;
      const rect = (event.target as HTMLElement).closest("[data-card]")!.getBoundingClientRect();
      wsRef.current.send(
        JSON.stringify({
          type: "launch",
          x: (event.clientX - rect.left) / rect.width,
          y: (event.clientY - rect.top) / rect.height,
        }),
      );
    },
    [connected, connect],
  );

  useEffect(() => {
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  return (
    <Card className="cursor-pointer" onClick={launch} data-card>
      <CardHeader>
        <CardTitle className="text-sm">Confetti</CardTitle>
        <CardDescription>
          {connected
            ? "Click anywhere and the server will launch delayed confetti"
            : "Click to connect and launch confetti"}
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

function IndexPage() {
  const queryClient = useQueryClient();
  const { data: pingData, isPending: pingPending } = useQuery(
    orpc.ping.queryOptions({ input: {} }),
  );
  const [showPirateSecret, setShowPirateSecret] = useState(false);
  const { data: pirateSecretData, isPending: pirateSecretPending } = useQuery({
    ...orpc.pirateSecret.queryOptions({ input: {} }),
    enabled: showPirateSecret,
  });
  const { data: thingsData, isPending: thingsPending } = useQuery(
    orpc.things.list.queryOptions({ input: { limit: 20, offset: 0 } }),
  );
  const [newThing, setNewThing] = useState("");
  const [busy, setBusy] = useState(false);
  const wsBase = useMemo(() => getWebSocketBaseUrl(), []);

  const handleCreate = useCallback(async () => {
    if (!newThing.trim()) return;
    setBusy(true);
    try {
      await fetch("/api/things", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ thing: newThing }),
      });
      setNewThing("");
      void queryClient.invalidateQueries({ queryKey: orpc.things.list.key() });
    } finally {
      setBusy(false);
    }
  }, [newThing, queryClient]);

  const handleDelete = useCallback(
    async (id: string) => {
      await fetch(`/api/things/${encodeURIComponent(id)}`, { method: "DELETE" });
      void queryClient.invalidateQueries({ queryKey: orpc.things.list.key() });
    },
    [queryClient],
  );

  return (
    <main className="mx-auto max-w-md space-y-4 p-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">oRPC Ping</CardTitle>
          <CardDescription>
            {pingPending ? "Loading..." : `${pingData?.message} @ ${pingData?.serverTime}`}
          </CardDescription>
        </CardHeader>
      </Card>

      <PingPongDemo wsBase={wsBase} />
      <ConfettiDemo wsBase={wsBase} />

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Pirate Secret</CardTitle>
          <CardDescription>Fetch a secret from the server-side env contract.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {!showPirateSecret ? (
            <Button size="sm" onClick={() => setShowPirateSecret(true)}>
              Reveal Pirate Secret
            </Button>
          ) : pirateSecretPending ? (
            <p className="text-xs text-muted-foreground">Loading secret...</p>
          ) : (
            <p className="rounded-md border p-3 text-xs font-mono">{pirateSecretData?.secret}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Things</CardTitle>
          <CardDescription>CRUD backed by Drizzle + SQLite/D1</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              placeholder="New thing..."
              value={newThing}
              onChange={(e) => setNewThing(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void handleCreate()}
            />
            <Button
              size="sm"
              disabled={busy || !newThing.trim()}
              onClick={() => void handleCreate()}
            >
              Add
            </Button>
          </div>
          {thingsPending && <p className="text-xs text-muted-foreground">Loading...</p>}
          {thingsData?.things.map((t) => (
            <div
              key={t.id}
              className="flex items-center justify-between rounded-md border p-2 text-xs"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate">{t.thing}</div>
                <div className="text-muted-foreground">{t.id.slice(0, 8)}</div>
              </div>
              <Button size="sm" variant="destructive" onClick={() => void handleDelete(t.id)}>
                Delete
              </Button>
            </div>
          ))}
          {thingsData && thingsData.things.length === 0 && (
            <p className="text-xs text-muted-foreground">No things yet. Create one above.</p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
