import { pathToFileURL } from "node:url";
import { createAdaptorServer } from "@hono/node-server";
import { agentsServiceManifest } from "@iterate-com/agents-contract";
import { Hono } from "hono";

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

const env = agentsServiceManifest.envVars.parse(process.env);
const port = env.AGENTS_SERVICE_PORT;

const app = new Hono();

app.get("/healthz", (c) => c.text("ok"));

function nowIso(): string {
  return new Date().toISOString();
}

function routeToAbsolute(baseUrl: string, destination: string): string {
  if (destination.startsWith("http://") || destination.startsWith("https://")) return destination;
  return `${baseUrl}${destination.startsWith("/") ? destination : `/${destination}`}`;
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

app.post("/api/agents/get-or-create", async (c) => {
  const body = (await c.req.json()) as { agentPath?: string };
  const agentPath = body.agentPath?.trim();
  if (!agentPath) return c.json({ error: "agentPath is required" }, 400);

  const existing = agents.get(agentPath);
  if (existing) {
    return c.json({ agent: existing, wasNewlyCreated: false });
  }

  const createdAt = nowIso();
  const destination = await createDestination(agentPath);
  const created: AgentRecord = {
    path: agentPath,
    destination,
    isWorking: false,
    shortStatus: "",
    createdAt,
    updatedAt: createdAt,
  };
  agents.set(agentPath, created);

  return c.json({ agent: created, wasNewlyCreated: true });
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
    }).catch(() => {});
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

app.post("/api/agents/forward/*", async (c) => {
  const suffix = c.req.path.slice("/api/agents/forward".length);
  const agentPath = suffix.startsWith("/") ? suffix : `/${suffix}`;
  if (agentPath === "/") return c.json({ error: "agent path missing" }, 400);

  let agent = agents.get(agentPath);
  if (!agent) {
    const destination = await createDestination(agentPath);
    const createdAt = nowIso();
    agent = {
      path: agentPath,
      destination,
      isWorking: false,
      shortStatus: "",
      createdAt,
      updatedAt: createdAt,
    };
    agents.set(agentPath, agent);
  }

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
