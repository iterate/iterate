import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Button } from "@iterate-com/ui/components/button";
import { orpc, orpcClient } from "@/frontend/lib/orpc.ts";

const pingQueryOptions = {
  ...orpc.ping.queryOptions({ input: {} }),
  staleTime: 30_000,
};

export const Route = createFileRoute("/_app/debug")({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(pingQueryOptions);
  },
  component: DebugPage,
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
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">WebSocket Ping-Pong</h2>
        <p className="text-sm text-muted-foreground">
          {status === "disconnected" && "Not connected"}
          {status === "connected" && "Connected, send a ping"}
          {status === "waiting" && "Waiting for pong (1s delay)..."}
        </p>
      </div>
      {status === "disconnected" ? (
        <Button size="sm" onClick={connect}>
          Connect
        </Button>
      ) : (
        <Button size="sm" onClick={sendPing} disabled={status === "waiting"}>
          Send Ping
        </Button>
      )}
      {lastPong && <p className="text-sm text-muted-foreground">Last pong: {lastPong}</p>}
    </section>
  );
}

function DebugPage() {
  const { data: pingData } = useQuery(pingQueryOptions);
  const [showPirateSecret, setShowPirateSecret] = useState(false);
  const { data: pirateSecretData, isPending: pirateSecretPending } = useQuery({
    ...orpc.pirateSecret.queryOptions({ input: {} }),
    enabled: showPirateSecret,
  });
  const [demoBusy, setDemoBusy] = useState(false);
  const [lastLogDemo, setLastLogDemo] = useState<{
    label: string;
    requestId: string;
    steps: string[];
  } | null>(null);
  const [lastServerError, setLastServerError] = useState<string | null>(null);
  const wsBase = useMemo(() => getWebSocketBaseUrl(), []);

  const handleBrowserThrow = useCallback(() => {
    console.log("[example] browser throw button pressed");
    throw new Error("Example browser test exception");
  }, []);

  const handleServerLogDemo = useCallback(async () => {
    console.log("[example] server log demo button pressed");
    setDemoBusy(true);
    setLastServerError(null);
    try {
      const result = await orpcClient.test.logDemo({ label: "frontend-button" });
      console.log("[example] server log demo result", result);
      setLastLogDemo(result);
    } finally {
      setDemoBusy(false);
    }
  }, []);

  const handleServerThrow = useCallback(async () => {
    console.log("[example] server throw button pressed");
    setDemoBusy(true);
    try {
      await orpcClient.test.serverThrow({
        message: "Example server test exception from the frontend button",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[example] server throw produced client-visible error", error);
      setLastServerError(message);
    } finally {
      setDemoBusy(false);
    }
  }, []);

  return (
    <div className="space-y-8 p-4">
      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Runtime deps demo</h2>
          <p className="text-sm text-muted-foreground">
            The terminal route uses a runtime-injected PTY dep in Node and a not-implemented
            fallback in Cloudflare.
          </p>
        </div>
        <Button asChild size="sm">
          <Link to="/terminal">Open web terminal</Link>
        </Button>
      </section>

      <section className="space-y-1">
        <h2 className="text-sm font-semibold">oRPC Ping</h2>
        <p className="text-sm text-muted-foreground">{`${pingData?.message} @ ${pingData?.serverTime}`}</p>
      </section>

      <PingPongDemo wsBase={wsBase} />

      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Pirate Secret</h2>
          <p className="text-sm text-muted-foreground">
            Fetch a secret from the server-side env contract.
          </p>
        </div>
        {!showPirateSecret ? (
          <Button size="sm" onClick={() => setShowPirateSecret(true)}>
            Reveal Pirate Secret
          </Button>
        ) : pirateSecretPending ? (
          <p className="text-sm text-muted-foreground">Loading secret...</p>
        ) : (
          <p className="rounded-md border p-3 font-mono text-sm">{pirateSecretData?.secret}</p>
        )}
      </section>

      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Observability / failure demo</h2>
          <p className="text-sm text-muted-foreground">
            Use these buttons to test browser exceptions, wide-event request logs on the server, and
            server-side exception reporting.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="destructive" onClick={handleBrowserThrow}>
            Throw in browser
          </Button>
          <Button size="sm" disabled={demoBusy} onClick={() => void handleServerLogDemo()}>
            Run server log demo
          </Button>
          <Button size="sm" disabled={demoBusy} onClick={() => void handleServerThrow()}>
            Throw on server
          </Button>
        </div>
        {lastLogDemo && (
          <div className="rounded-md border p-3 text-sm">
            <p className="font-medium">Last server log demo</p>
            <p className="text-muted-foreground">requestId: {lastLogDemo.requestId}</p>
            <p className="text-muted-foreground">label: {lastLogDemo.label}</p>
            <p className="text-muted-foreground">steps: {lastLogDemo.steps.join(" -> ")}</p>
          </div>
        )}
        {lastServerError && (
          <div className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
            Last server error seen by client: {lastServerError}
          </div>
        )}
      </section>
    </div>
  );
}
