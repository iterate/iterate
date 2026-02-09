import {
  handleHealthz,
  handleHome,
  handleTail,
  handleTransform,
  handleWsClose,
  handleWsMessage,
  handleWsOpen,
  handleWsUpgrade,
} from "./routes.ts";
import { createLogger, deriveTarget, nextRequestId } from "./utils.ts";
import type { ProxySocketData } from "./utils.ts";

const LOG_PATH = process.env.EGRESS_LOG_PATH ?? "/tmp/egress-proxy.log";
const VIEWER_PORT = Number(process.env.EGRESS_VIEWER_PORT ?? "18081");
const PROOF_PREFIX = process.env.PROOF_PREFIX ?? "I was inserted by the egress proxy lol\n";
const TRANSFORM_TIMEOUT_MS = Number(process.env.TRANSFORM_TIMEOUT_MS ?? "5000");

const INDEX_HTML = Bun.file(new URL("./index.html", import.meta.url));
const WS_DEFAULTS = {
  target: process.env.WS_DEFAULT_TARGET ?? "wss://echo.websocket.events",
};

const logger = createLogger(LOG_PATH);
logger.appendLog(`BOOT pid=${process.pid} viewer_port=${VIEWER_PORT}`);

Bun.serve<ProxySocketData>({
  port: VIEWER_PORT,
  hostname: "::",
  fetch(request, server) {
    const url = new URL(request.url);

    const transformTarget = deriveTarget(request);
    if (transformTarget !== null) {
      const requestId = nextRequestId("http");
      return handleTransform(request, transformTarget, requestId, logger, {
        proofPrefix: PROOF_PREFIX,
        transformTimeoutMs: TRANSFORM_TIMEOUT_MS,
      });
    }

    if (url.pathname === "/") return handleHome(INDEX_HTML);
    if (url.pathname === "/healthz") return handleHealthz();
    if (url.pathname === "/api/tail") return handleTail(url, logger);
    if (url.pathname === "/api/ws/proxy")
      return handleWsUpgrade(request, server, url, logger, WS_DEFAULTS);

    return new Response("not found\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
  websocket: {
    open(ws) {
      handleWsOpen(ws, logger);
    },
    message(ws, message) {
      handleWsMessage(ws, message, logger);
    },
    close(ws, code, reason) {
      handleWsClose(ws, code, reason, logger);
    },
  },
});

logger.appendLog(`VIEWER_LISTEN port=${VIEWER_PORT}`);
