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
import type { RouteDeps } from "./routes.ts";
import fs from "node:fs";
import { createLogger, deriveTarget, json, nextRequestId } from "./utils.ts";
import type { ProxySocketData } from "./utils.ts";
import { createSecretStore } from "./secrets.ts";
import type { SecretsFile } from "./secrets.ts";
import { createPolicyStore } from "./policies.ts";
import type { PoliciesFile } from "./policies.ts";
import { createApprovalCoordinator } from "./approval.ts";
import { createEventBus } from "./events.ts";
import { createCostTracker } from "./cost-tracker.ts";

const LOG_PATH = process.env.EGRESS_LOG_PATH ?? "/tmp/egress-proxy.log";
const VIEWER_PORT = Number(process.env.EGRESS_VIEWER_PORT ?? "18081");
const PROOF_PREFIX = process.env.PROOF_PREFIX ?? "__ITERATE_MITM_PROOF__\n";
const TRANSFORM_TIMEOUT_MS = Number(process.env.TRANSFORM_TIMEOUT_MS ?? "5000");
const DATA_DIR = process.env.EGRESS_DATA_DIR ?? "/data";
const SECRETS_PATH = process.env.EGRESS_SECRETS_PATH ?? `${DATA_DIR}/secrets.json`;
const POLICIES_PATH = process.env.EGRESS_POLICIES_PATH ?? `${DATA_DIR}/policies.json`;

const INDEX_HTML = Bun.file(new URL("./index.html", import.meta.url));
const WS_DEFAULTS = {
  target: process.env.WS_DEFAULT_TARGET ?? "wss://echo.websocket.events",
};

const logger = createLogger(LOG_PATH);
logger.appendLog(`BOOT pid=${process.pid} viewer_port=${VIEWER_PORT}`);

// Initialize stores
const secrets = createSecretStore(SECRETS_PATH, logger);
const policies = createPolicyStore(POLICIES_PATH, logger);
const approvals = createApprovalCoordinator();
const events = createEventBus();
const costs = await createCostTracker(logger);

// Wrap logger to also broadcast log lines via SSE
const originalAppendLog = logger.appendLog;
logger.appendLog = (message: string): void => {
  originalAppendLog(message);
  events.broadcast("log", { line: `${new Date().toISOString()} ${message}` });
};

const deps: RouteDeps = { secrets, policies, approvals, events, costs };

const transformConfig = {
  proofPrefix: PROOF_PREFIX,
  transformTimeoutMs: TRANSFORM_TIMEOUT_MS,
};

// --- API route handlers ---

function handleApiApprove(approvalId: string): Response {
  const found = approvals.decide(approvalId, "approved");
  if (!found) return json({ error: "approval not found or already decided" }, 404);
  logger.appendLog(`APPROVAL_DECIDE id=${approvalId} decision=approved`);
  return json({ success: true, decision: "approved" });
}

function handleApiReject(approvalId: string): Response {
  const found = approvals.decide(approvalId, "rejected");
  if (!found) return json({ error: "approval not found or already decided" }, 404);
  logger.appendLog(`APPROVAL_DECIDE id=${approvalId} decision=rejected`);
  return json({ success: true, decision: "rejected" });
}

function handleApiApprovals(): Response {
  return json({ approvals: approvals.listPending() });
}

function handleApiSecrets(): Response {
  return json({ keys: secrets.getKeys(), count: secrets.getCount() });
}

function handleApiPolicies(): Response {
  return json({ policies: policies.getPolicies(), count: policies.getCount() });
}

function handleApiEvents(): Response {
  return events.createStream();
}

async function handleApiSecretsWrite(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as SecretsFile;
    if (!Array.isArray(body.secrets)) {
      return json({ error: "body must have a 'secrets' array" }, 400);
    }
    const content = JSON.stringify(body, null, 2);
    fs.writeFileSync(SECRETS_PATH, content + "\n");
    logger.appendLog(`SECRETS_WRITE count=${body.secrets.length}`);
    return json({ success: true, count: body.secrets.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, 400);
  }
}

function handleApiPoliciesRaw(): Response {
  try {
    const raw = fs.readFileSync(POLICIES_PATH, "utf8");
    return new Response(raw, {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } catch {
    return json({ policies: [] });
  }
}

async function handleApiPoliciesWrite(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as PoliciesFile;
    if (!Array.isArray(body.policies)) {
      return json({ error: "body must have a 'policies' array" }, 400);
    }
    const content = JSON.stringify(body, null, 2);
    fs.writeFileSync(POLICIES_PATH, content + "\n");
    logger.appendLog(`POLICIES_WRITE count=${body.policies.length}`);
    return json({ success: true, count: body.policies.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, 400);
  }
}

function handleApiCosts(): Response {
  return json(costs.getSummary());
}

function handleApiCostsReset(): Response {
  costs.reset();
  logger.appendLog("COSTS_RESET");
  return json({ success: true });
}

function handleApiStatus(): Response {
  const summary = costs.getSummary();
  return json({
    secrets: secrets.getCount(),
    policies: policies.getCount(),
    pendingApprovals: approvals.pendingCount(),
    sseClients: events.clientCount(),
    modelsLoaded: costs.modelsLoaded(),
    totalCost: summary.totalCost,
    totalRequests: summary.records.length,
  });
}

// --- Main server ---

Bun.serve<ProxySocketData>({
  port: VIEWER_PORT,
  hostname: "::",
  fetch(request, server) {
    const url = new URL(request.url);

    // Proxied HTTP requests (from Go MITM)
    const transformTarget = deriveTarget(request);
    if (transformTarget !== null) {
      const requestId = nextRequestId("http");
      return handleTransform(request, transformTarget, requestId, logger, transformConfig, deps);
    }

    // Static pages
    if (url.pathname === "/") return handleHome(INDEX_HTML);
    if (url.pathname === "/healthz") return handleHealthz();

    // Log tail (kept for backwards compat, SSE is preferred)
    if (url.pathname === "/api/tail") return handleTail(url, logger);

    // SSE event stream
    if (url.pathname === "/api/events") return handleApiEvents();

    // Status
    if (url.pathname === "/api/status") return handleApiStatus();

    // Approvals
    if (url.pathname === "/api/approvals" && request.method === "GET") {
      return handleApiApprovals();
    }

    const approveMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/approve$/);
    if (approveMatch && request.method === "POST") {
      return handleApiApprove(approveMatch[1]);
    }

    const rejectMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/reject$/);
    if (rejectMatch && request.method === "POST") {
      return handleApiReject(rejectMatch[1]);
    }

    // Secrets
    if (url.pathname === "/api/secrets" && request.method === "GET") {
      return handleApiSecrets();
    }
    if (url.pathname === "/api/secrets" && request.method === "PUT") {
      return handleApiSecretsWrite(request);
    }
    // Policies
    if (url.pathname === "/api/policies" && request.method === "GET") {
      return handleApiPolicies();
    }
    if (url.pathname === "/api/policies" && request.method === "PUT") {
      return handleApiPoliciesWrite(request);
    }
    if (url.pathname === "/api/policies/raw" && request.method === "GET") {
      return handleApiPoliciesRaw();
    }

    // Costs
    if (url.pathname === "/api/costs" && request.method === "GET") {
      return handleApiCosts();
    }
    if (url.pathname === "/api/costs/reset" && request.method === "POST") {
      return handleApiCostsReset();
    }

    // WebSocket proxy
    if (url.pathname === "/api/ws/proxy") {
      return handleWsUpgrade(request, server, url, logger, WS_DEFAULTS, deps);
    }

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
      handleWsMessage(ws, message, logger, deps);
    },
    close(ws, code, reason) {
      handleWsClose(ws, code, reason, logger);
    },
  },
});

logger.appendLog(`VIEWER_LISTEN port=${VIEWER_PORT}`);
