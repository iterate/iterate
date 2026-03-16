import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { orpc } from "@/lib/orpc.ts";

export const Route = createFileRoute("/")({
  component: IndexPage,
});

function getWebSocketURL(pathname: string) {
  const url = new URL(window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function readPingResult(data: unknown) {
  if (!data || typeof data !== "object") {
    return null;
  }

  if ("json" in data && data.json && typeof data.json === "object") {
    const payload = data.json as { message?: unknown; serverTime?: unknown };
    if (typeof payload.message === "string" && typeof payload.serverTime === "string") {
      return {
        message: payload.message,
        serverTime: payload.serverTime,
      };
    }
  }

  const payload = data as { message?: unknown; serverTime?: unknown };
  if (typeof payload.message === "string" && typeof payload.serverTime === "string") {
    return {
      message: payload.message,
      serverTime: payload.serverTime,
    };
  }

  return null;
}

function IndexPage() {
  const { data, isPending, error } = useQuery(orpc.ping.queryOptions({ input: {} }));
  const [wsState, setWsState] = useState("connecting");
  const [lastEvent, setLastEvent] = useState("waiting for websocket open");
  const socketURL = useMemo(() => getWebSocketURL("/orpc/ws"), []);
  const ping = readPingResult(data);

  useEffect(() => {
    const socket = new WebSocket(socketURL);

    socket.addEventListener("open", () => {
      setWsState("connected");
      setLastEvent("open");
    });
    socket.addEventListener("close", (event) => {
      setWsState(`closed (${event.code})`);
      setLastEvent("close");
    });
    socket.addEventListener("error", () => {
      setWsState("error");
      setLastEvent("error");
    });

    return () => {
      socket.close();
    };
  }, [socketURL]);

  return (
    <main className="page-shell">
      <div className="panel">
        <p className="eyebrow">ws-test</p>
        <h1>Hono up front spike</h1>
        <p className="lede">
          Reduced service using the Hono Vite dev-server plugin first, TanStack Router on the
          client, oRPC over HTTP at <code>/rpc</code>, and a websocket upgrade attached directly to
          the same Vite HTTP server at <code>/orpc/ws</code>.
        </p>
      </div>

      <div className="grid">
        <section className="card">
          <h2>oRPC HTTP</h2>
          <p className="meta">
            Querying <code>GET /rpc/ping</code> through the oRPC client.
          </p>
          {isPending ? <p>Loading...</p> : null}
          {error ? <p className="error">{String(error)}</p> : null}
          {ping ? (
            <dl className="facts">
              <div>
                <dt>Message</dt>
                <dd>{ping.message}</dd>
              </div>
              <div>
                <dt>Server time</dt>
                <dd>{ping.serverTime}</dd>
              </div>
            </dl>
          ) : null}
        </section>

        <section className="card">
          <h2>WebSocket</h2>
          <p className="meta">
            Opening a browser websocket to <code>{socketURL}</code>.
          </p>
          <dl className="facts">
            <div>
              <dt>Status</dt>
              <dd>{wsState}</dd>
            </div>
            <div>
              <dt>Last event</dt>
              <dd>{lastEvent}</dd>
            </div>
          </dl>
        </section>
      </div>
    </main>
  );
}
