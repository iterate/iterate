/**
 * Flexible test daemon for s6 supervision testing
 *
 * Usage: node --experimental-strip-types test-daemon.ts [options]
 *
 * Options:
 *   --name <name>           Service name (default: "test-daemon")
 *   --port <port>           Port to listen on (default: 3001)
 *   --startup-delay <ms>    Delay before becoming healthy (default: 0)
 *   --upstream <url>        Upstream service to proxy/check (optional)
 *   --health-path <path>    Health endpoint path (default: /health)
 *   --ping-path <path>      Ping endpoint path (default: /ping)
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

// Parse CLI args
const args = process.argv.slice(2);
const getArg = (name: string, defaultValue: string): string => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultValue;
};

const NAME = getArg("name", process.env.DAEMON_NAME || "test-daemon");
const PORT = parseInt(getArg("port", process.env.PORT || "3001"), 10);
const STARTUP_DELAY = parseInt(getArg("startup-delay", process.env.STARTUP_DELAY || "0"), 10);
const UPSTREAM = getArg("upstream", process.env.UPSTREAM || "");
const HEALTH_PATH = getArg("health-path", "/health");
const PING_PATH = getArg("ping-path", "/ping");

let isReady = false;
const startTime = Date.now();

// Graceful shutdown
function setupGracefulShutdown(server: Server): void {
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[${NAME}] ${signal} received, shutting down...`);

    server.close(() => {
      console.log(`[${NAME}] Server closed`);
      process.exit(0);
    });

    setTimeout(() => {
      console.error(`[${NAME}] Forced exit`);
      process.exit(1);
    }, 2500);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Fetch upstream if configured
async function fetchUpstream(): Promise<{ ok: boolean; body: string }> {
  if (!UPSTREAM) return { ok: true, body: "" };

  try {
    const res = await fetch(UPSTREAM);
    const body = await res.text();
    return { ok: res.ok, body };
  } catch (err) {
    return { ok: false, body: String(err) };
  }
}

// Request handler
async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url || "/";
  const uptime = Date.now() - startTime;

  // Health endpoint
  if (url === HEALTH_PATH) {
    if (!isReady) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "starting",
          name: NAME,
          uptime,
          readyIn: STARTUP_DELAY - uptime,
        }),
      );
      return;
    }

    // If we have an upstream, check it for health
    if (UPSTREAM) {
      const upstream = await fetchUpstream();
      if (!upstream.ok) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "upstream_unhealthy",
            name: NAME,
            upstream: UPSTREAM,
            error: upstream.body,
          }),
        );
        return;
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        name: NAME,
        uptime,
        timestamp: new Date().toISOString(),
      }),
    );
    return;
  }

  // Ping endpoint
  if (url === PING_PATH) {
    if (UPSTREAM) {
      // Proxy mode: call upstream and append our name
      const upstream = await fetchUpstream();
      const upstreamResponse = upstream.ok ? upstream.body.trim() : `[error: ${upstream.body}]`;
      res.writeHead(upstream.ok ? 200 : 502, { "Content-Type": "text/plain" });
      res.end(`${upstreamResponse} -> ${NAME}`);
    } else {
      // Simple mode: just respond with our name
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`pong from ${NAME}`);
    }
    return;
  }

  // Info endpoint
  if (url === "/info") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        {
          name: NAME,
          port: PORT,
          uptime,
          startupDelay: STARTUP_DELAY,
          upstream: UPSTREAM || null,
          ready: isReady,
        },
        null,
        2,
      ),
    );
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
}

// Main
const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error(`[${NAME}] Error handling request:`, err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal Server Error");
  });
});

setupGracefulShutdown(server);

server.listen(PORT, () => {
  console.log(`[${NAME}] Listening on port ${PORT}`);

  if (STARTUP_DELAY > 0) {
    console.log(`[${NAME}] Startup delay: ${STARTUP_DELAY}ms`);
    setTimeout(() => {
      isReady = true;
      console.log(`[${NAME}] Ready after ${STARTUP_DELAY}ms delay`);
    }, STARTUP_DELAY);
  } else {
    isReady = true;
    console.log(`[${NAME}] Ready immediately`);
  }

  if (UPSTREAM) {
    console.log(`[${NAME}] Upstream: ${UPSTREAM}`);
  }
});
