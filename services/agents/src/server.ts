import { pathToFileURL } from "node:url";
import { createAdaptorServer } from "@hono/node-server";
import { agentsServiceManifest } from "@iterate-com/agents-contract";
import { Hono } from "hono";
import { mountServiceSubRouterHttpRoutes } from "../../../packages/shared/src/jonasland/index.ts";

interface AgentRecord {
  path: string;
  destination: string | null;
  isWorking: boolean;
  shortStatus: string;
  createdAt: string;
  updatedAt: string;
}

const agents = new Map<string, AgentRecord>();
const subscriptions = new Map<string, Set<string>>();
const inFlightAgentCreations = new Map<string, Promise<AgentRecord>>();

const env = agentsServiceManifest.envVars.parse(process.env);
const port = env.AGENTS_SERVICE_PORT;

const app = new Hono();

app.get("/healthz", (c) => c.text("ok"));
mountServiceSubRouterHttpRoutes({ app, manifest: agentsServiceManifest });

function nowIso(): string {
  return new Date().toISOString();
}

function routeToAbsolute(baseUrl: string, destination: string): string {
  if (destination.startsWith("http://") || destination.startsWith("https://")) return destination;
  return `${baseUrl}${destination.startsWith("/") ? destination : `/${destination}`}`;
}

function pruneSubscription(agentPath: string, callbackUrl: string): void {
  const urls = subscriptions.get(agentPath);
  if (!urls) return;
  urls.delete(callbackUrl);
  if (urls.size === 0) {
    subscriptions.delete(agentPath);
  }
}

async function createDestination(agentPath: string): Promise<string> {
  const response = await fetch(`${env.OPENCODE_WRAPPER_BASE_URL}/new`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentPath }),
  });

  if (!response.ok) {
    throw new Error(`opencode-wrapper create failed: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as { route: string };
  return routeToAbsolute(env.OPENCODE_WRAPPER_BASE_URL, payload.route);
}

function createAgentRecord(agentPath: string, destination: string): AgentRecord {
  const createdAt = nowIso();
  return {
    path: agentPath,
    destination,
    isWorking: false,
    shortStatus: "",
    createdAt,
    updatedAt: createdAt,
  };
}

async function getOrCreateAgentRecord(
  agentPath: string,
): Promise<{ agent: AgentRecord; wasNewlyCreated: boolean }> {
  const existing = agents.get(agentPath);
  if (existing) {
    return { agent: existing, wasNewlyCreated: false };
  }

  let pending = inFlightAgentCreations.get(agentPath);
  if (!pending) {
    pending = (async () => {
      const destination = await createDestination(agentPath);
      const created = createAgentRecord(agentPath, destination);
      agents.set(agentPath, created);
      return created;
    })();
    inFlightAgentCreations.set(agentPath, pending);
    void pending
      .finally(() => {
        if (inFlightAgentCreations.get(agentPath) === pending) {
          inFlightAgentCreations.delete(agentPath);
        }
      })
      .catch(() => {});

    const created = await pending;
    return { agent: created, wasNewlyCreated: true };
  }

  const resolved = await pending;
  return { agent: resolved, wasNewlyCreated: false };
}

app.post("/api/agents/get-or-create", async (c) => {
  const body = (await c.req.json()) as { agentPath?: string };
  const agentPath = body.agentPath?.trim();
  if (!agentPath) return c.json({ error: "agentPath is required" }, 400);

  const { agent, wasNewlyCreated } = await getOrCreateAgentRecord(agentPath);
  return c.json({ agent, wasNewlyCreated });
});

app.post("/api/agents/update", async (c) => {
  const body = (await c.req.json()) as {
    path?: string;
    destination?: string | null;
    isWorking?: boolean;
    shortStatus?: string;
  };

  const path = body.path?.trim();
  if (!path) return c.json({ error: "path is required" }, 400);

  const existing = agents.get(path);
  if (!existing) return c.json({ error: "agent not found" }, 404);

  const updated: AgentRecord = {
    ...existing,
    ...(body.destination !== undefined ? { destination: body.destination } : {}),
    ...(body.isWorking !== undefined ? { isWorking: body.isWorking } : {}),
    ...(body.shortStatus !== undefined ? { shortStatus: body.shortStatus } : {}),
    updatedAt: nowIso(),
  };

  agents.set(path, updated);

  const callbackUrls = subscriptions.get(path) ?? new Set<string>();
  const callbackBody = JSON.stringify({
    type: "iterate:agent-updated",
    payload: updated,
  });
  for (const callbackUrl of callbackUrls) {
    void fetch(callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: callbackBody,
    })
      .then((response) => {
        if (!response.ok) {
          pruneSubscription(path, callbackUrl);
        }
      })
      .catch(() => {
        pruneSubscription(path, callbackUrl);
      });
  }

  return c.json({ ok: true as const, agent: updated });
});

app.post("/api/agents/subscribe", async (c) => {
  const body = (await c.req.json()) as { agentPath?: string; callbackUrl?: string };
  const agentPath = body.agentPath?.trim();
  const callbackUrl = body.callbackUrl?.trim();
  if (!agentPath || !callbackUrl) {
    return c.json({ error: "agentPath and callbackUrl are required" }, 400);
  }

  let urls = subscriptions.get(agentPath);
  if (!urls) {
    urls = new Set<string>();
    subscriptions.set(agentPath, urls);
  }
  urls.add(callbackUrl);

  return c.json({ ok: true as const });
});

app.post("/api/agents/unsubscribe", async (c) => {
  const body = (await c.req.json()) as { agentPath?: string; callbackUrl?: string };
  const agentPath = body.agentPath?.trim();
  const callbackUrl = body.callbackUrl?.trim();
  if (!agentPath || !callbackUrl) {
    return c.json({ error: "agentPath and callbackUrl are required" }, 400);
  }

  pruneSubscription(agentPath, callbackUrl);
  return c.json({ ok: true as const });
});

app.post("/api/agents/forward/*", async (c) => {
  const suffix = c.req.path.slice("/api/agents/forward".length);
  const agentPath = suffix.startsWith("/") ? suffix : `/${suffix}`;
  if (agentPath === "/") return c.json({ error: "agent path missing" }, 400);

  const { agent } = await getOrCreateAgentRecord(agentPath);

  if (!agent.destination) {
    return c.json({ error: "agent destination unavailable" }, 503);
  }

  const body = await c.req.json();
  const upstream = await fetch(agent.destination, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-iterate-agent-path": agentPath,
    },
    body: JSON.stringify(body),
  });

  const text = await upstream.text();
  c.header("content-type", upstream.headers.get("content-type") ?? "application/json");
  c.status(upstream.status as never);
  return c.body(text);
});

export const startAgentsService = async () => {
  const server = createAdaptorServer({ fetch: app.fetch });
  await new Promise<void>((resolve) => {
    server.listen(port, "0.0.0.0", () => resolve());
  });

  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
};

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  void startAgentsService();
}
