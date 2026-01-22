/**
 * Benchmark sandbox server
 *
 * This runs inside the sandbox container and:
 * 1. On boot: POSTs callback to BENCHMARK_CALLBACK_URL with timestamps
 * 2. Serves GET /ping for latency measurement
 * 3. Serves WebSocket /ws/terminal for PTY debugging
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { cpus, totalmem, hostname } from "node:os";
import { WebSocketServer } from "ws";
import { createTerminalHandler } from "./terminal.js";

const PORT = parseInt(process.env.BENCHMARK_PORT ?? "8080", 10);
const CALLBACK_URL = process.env.BENCHMARK_CALLBACK_URL;
const SANDBOX_ID = process.env.BENCHMARK_SANDBOX_ID;

// Track timestamps and callback status
const processStart = Date.now();
const callbackStatus: {
  attempted: boolean;
  success: boolean | null;
  error: string | null;
  responseStatus: number | null;
  attemptedAt: number | null;
} = {
  attempted: false,
  success: null,
  error: null,
  responseStatus: null,
  attemptedAt: null,
};

async function main() {
  console.log(`[sandbox-server] Starting on port ${PORT}...`);
  console.log(`[sandbox-server] SANDBOX_ID: ${SANDBOX_ID}`);
  console.log(`[sandbox-server] CALLBACK_URL: ${CALLBACK_URL}`);

  // Create HTTP server
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // GET /ping - for latency measurement
    if (req.method === "GET" && req.url === "/ping") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("pong");
      return;
    }

    // GET /health - health check
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          sandboxId: SANDBOX_ID,
          uptime: Date.now() - processStart,
        }),
      );
      return;
    }

    // GET /stats - system stats
    if (req.method === "GET" && req.url === "/stats") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          sandboxId: SANDBOX_ID,
          hostname: hostname(),
          cpuCount: cpus().length,
          memoryTotal: totalmem(),
          uptime: Date.now() - processStart,
        }),
      );
      return;
    }

    // GET /debug - debug info including callback status
    if (req.method === "GET" && req.url === "/debug") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          sandboxId: SANDBOX_ID,
          callbackUrl: CALLBACK_URL,
          callbackStatus,
          uptime: Date.now() - processStart,
          env: {
            BENCHMARK_CALLBACK_URL: process.env.BENCHMARK_CALLBACK_URL ?? "(not set)",
            BENCHMARK_SANDBOX_ID: process.env.BENCHMARK_SANDBOX_ID ?? "(not set)",
            BENCHMARK_PORT: process.env.BENCHMARK_PORT ?? "(not set)",
          },
        }),
      );
      return;
    }

    // Serve simple HTML page for terminal at root
    if (req.method === "GET" && (req.url === "/" || req.url === "/terminal")) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(getTerminalHtml());
      return;
    }

    // 404 for everything else
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  // Create WebSocket server for terminal
  const wss = new WebSocketServer({ server, path: "/ws/terminal" });
  createTerminalHandler(wss);

  // Start server
  const serverListening = await new Promise<number>((resolve) => {
    server.listen(PORT, () => {
      console.log(`[sandbox-server] Listening on port ${PORT}`);
      resolve(Date.now());
    });
  });

  // Send callback to benchmark runner
  if (CALLBACK_URL && SANDBOX_ID) {
    callbackStatus.attempted = true;
    callbackStatus.attemptedAt = Date.now();
    try {
      console.log(`[sandbox-server] Sending callback to ${CALLBACK_URL}...`);
      const response = await fetch(CALLBACK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sandboxId: SANDBOX_ID,
          timestamps: {
            processStart,
            serverListening,
          },
          system: {
            hostname: hostname(),
            cpuCount: cpus().length,
            memoryTotal: totalmem(),
          },
        }),
      });

      callbackStatus.responseStatus = response.status;
      if (response.ok) {
        callbackStatus.success = true;
        console.log(`[sandbox-server] Callback sent successfully`);
      } else {
        callbackStatus.success = false;
        callbackStatus.error = `HTTP ${response.status}`;
        console.error(`[sandbox-server] Callback failed: ${response.status}`);
      }
    } catch (error) {
      callbackStatus.success = false;
      callbackStatus.error = String(error);
      console.error(`[sandbox-server] Error sending callback:`, error);
    }
  } else {
    console.log(`[sandbox-server] No callback URL configured, skipping callback`);
  }

  console.log(`[sandbox-server] Ready!`);
  console.log(`[sandbox-server] - Ping: http://localhost:${PORT}/ping`);
  console.log(`[sandbox-server] - Terminal: http://localhost:${PORT}/terminal`);
  console.log(`[sandbox-server] - WebSocket: ws://localhost:${PORT}/ws/terminal`);
}

function getTerminalHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Benchmark Sandbox Terminal</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css" />
  <style>
    body { margin: 0; padding: 20px; background: #1e1e1e; }
    h1 { color: #fff; font-family: monospace; margin-bottom: 10px; }
    #terminal { height: calc(100vh - 100px); }
    .info { color: #888; font-family: monospace; margin-bottom: 20px; }
  </style>
</head>
<body>
  <h1>Benchmark Sandbox Terminal</h1>
  <div class="info">Sandbox ID: ${SANDBOX_ID ?? "unknown"}</div>
  <div id="terminal"></div>
  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
  <script>
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Monaco, monospace',
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal'));
    fitAddon.fit();

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(protocol + '//' + location.host + '/ws/terminal');

    ws.onopen = () => {
      term.write('Connected to sandbox terminal\\r\\n');
      // Send initial size
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = (event) => {
      term.write(event.data);
    };

    ws.onclose = () => {
      term.write('\\r\\n\\x1b[31mDisconnected\\x1b[0m\\r\\n');
    };

    term.onData((data) => {
      ws.send(JSON.stringify({ type: 'input', data }));
    });

    window.addEventListener('resize', () => {
      fitAddon.fit();
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    });
  </script>
</body>
</html>`;
}

main().catch(console.error);
