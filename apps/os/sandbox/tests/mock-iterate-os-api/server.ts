import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { implement, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/node";
import { workerContract } from "../../../../daemon/server/orpc/contract.ts";
import type {
  EgressHandler,
  EgressRequest,
  MockIterateOsApi,
  OrpcRequest,
  RecordedRequest,
  RepoInfo,
} from "./types.ts";

type OrpcConfig = {
  getEnvResponse: { envVars: Record<string, string>; repos: RepoInfo[] };
  reportStatusResponse: { success: boolean };
};

type EgressConfig = {
  secrets: Record<string, string>;
  handlers: Array<{ pattern: string | RegExp; handler: EgressHandler }>;
};

const MAGIC_STRING_PATTERN = /getIterateSecret\(\s*\{([^}]+)\}\s*\)/g;

function normalizeHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.join(",") : (value ?? ""),
    ]),
  );
}

function extractSecretKey(payload: string): string | null {
  const match = payload.match(/secretKey\s*:\s*['"]([^'"]+)['"]/);
  return match ? match[1] : null;
}

function resolveMagicStrings(
  input: string,
  resolveSecret: (secretKey: string) => string | undefined,
  recordResolution: (secretKey: string) => void,
): string {
  return input.replace(MAGIC_STRING_PATTERN, (match, inner) => {
    const secretKey = extractSecretKey(inner);
    if (!secretKey) return match;
    recordResolution(secretKey);
    const value = resolveSecret(secretKey);
    return value ?? match;
  });
}

function resolveSecretsDeep(
  input: unknown,
  resolveSecret: (secretKey: string) => string | undefined,
  recordResolution: (secretKey: string) => void,
): unknown {
  if (typeof input === "string") {
    return resolveMagicStrings(input, resolveSecret, recordResolution);
  }
  if (Array.isArray(input)) {
    return input.map((value) => resolveSecretsDeep(value, resolveSecret, recordResolution));
  }
  if (input && typeof input === "object") {
    return Object.fromEntries(
      Object.entries(input).map(([key, value]) => [
        key,
        resolveSecretsDeep(value, resolveSecret, recordResolution),
      ]),
    );
  }
  return input;
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  const body = Buffer.from(await response.arrayBuffer());
  res.end(body);
}

export function createMockIterateOsApi(): MockIterateOsApi {
  const requests: RecordedRequest[] = [];
  const orpcConfig: OrpcConfig = {
    getEnvResponse: { envVars: {}, repos: [] },
    reportStatusResponse: { success: true },
  };
  const egressConfig: EgressConfig = {
    secrets: {},
    handlers: [],
  };

  const os = implement(workerContract);
  const getEnv = os.machines.getEnv.handler(({ input }) => {
    console.log("[mock] oRPC machines.getEnv:", input);
    requests.push({
      type: "orpc",
      procedure: "machines.getEnv",
      input,
      timestamp: new Date(),
    } satisfies OrpcRequest);
    return orpcConfig.getEnvResponse;
  });
  const reportStatus = os.machines.reportStatus.handler(({ input }) => {
    console.log("[mock] oRPC machines.reportStatus:", input);
    requests.push({
      type: "orpc",
      procedure: "machines.reportStatus",
      input,
      timestamp: new Date(),
    } satisfies OrpcRequest);
    return orpcConfig.reportStatusResponse;
  });
  const router = os.router({
    machines: { getEnv, reportStatus },
  });

  const orpcHandler = new RPCHandler(router, {
    interceptors: [
      onError((error) => {
        console.error("[mock] oRPC error:", error);
      }),
    ],
  });
  let server: Server | null = null;
  let port = 0;

  const modelsDevStub = {
    openai: {
      id: "openai",
      name: "OpenAI",
      env: ["OPENAI_API_KEY"],
      api: "https://api.openai.com/v1",
      models: {
        "gpt-4o-mini": {
          id: "gpt-4o-mini",
          name: "GPT-4o mini",
          family: "gpt",
          attachment: false,
          reasoning: false,
          tool_call: true,
          structured_output: true,
          temperature: true,
          modalities: { input: ["text"], output: ["text"] },
          cost: {
            input: 0.15,
            output: 0.6,
            cache_read: 0.03,
            context_over_200k: { input: 0.3, output: 1.2 },
          },
          limit: { context: 128000, output: 16384 },
        },
      },
    },
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      env: ["ANTHROPIC_API_KEY"],
      api: "https://api.anthropic.com/v1",
      models: {
        "claude-opus-4-5": {
          id: "claude-opus-4-5",
          name: "Claude Opus 4.5",
          family: "claude",
          attachment: false,
          reasoning: false,
          tool_call: true,
          structured_output: true,
          temperature: true,
          modalities: { input: ["text"], output: ["text"] },
          cost: {
            input: 5,
            output: 15,
            cache_read: 1.25,
            context_over_200k: { input: 10, output: 30 },
          },
          limit: { context: 200000, output: 8192 },
        },
        "claude-sonnet-4-5": {
          id: "claude-sonnet-4-5",
          name: "Claude Sonnet 4.5",
          family: "claude",
          attachment: false,
          reasoning: false,
          tool_call: true,
          structured_output: true,
          temperature: true,
          modalities: { input: ["text"], output: ["text"] },
          cost: {
            input: 3,
            output: 9,
            cache_read: 0.75,
            context_over_200k: { input: 6, output: 18 },
          },
          limit: { context: 200000, output: 8192 },
        },
      },
    },
  };

  function recordSecretResolution(secretKey: string): void {
    requests.push({
      type: "egress",
      method: "POST",
      path: "/api/egress/resolve-secret",
      headers: {},
      body: { secretKey },
      timestamp: new Date(),
    });
  }

  function resolveSecret(secretKey: string): string | undefined {
    return egressConfig.secrets[secretKey];
  }

  async function handleOrpc(req: IncomingMessage, res: ServerResponse) {
    try {
      console.log(`[mock] oRPC request ${req.method ?? "GET"} ${req.url ?? "/"}`);
      const { matched } = await orpcHandler.handle(req, res, { prefix: "/api/orpc" });
      if (!matched) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      }
    } catch (error) {
      console.error("[mock] oRPC handler failed:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "orpc_handler_failed" }));
    }
  }

  async function handleEgress(req: IncomingMessage, res: ServerResponse, body: Buffer) {
    const headers = normalizeHeaders(req.headers);
    const rawBody = body.length ? body.toString() : "";
    const parsedBody = rawBody
      ? (() => {
          try {
            return JSON.parse(rawBody);
          } catch {
            return rawBody;
          }
        })()
      : undefined;

    const originalUrl = headers["x-iterate-original-url"] ?? req.url ?? "/api/egress-proxy";
    const resolvedPath = resolveMagicStrings(originalUrl, resolveSecret, recordSecretResolution);
    const resolvedHeaders = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [
        key,
        resolveMagicStrings(value, resolveSecret, recordSecretResolution),
      ]),
    );
    const resolvedBody = resolveSecretsDeep(parsedBody, resolveSecret, recordSecretResolution);

    const egressReq: EgressRequest = {
      type: "egress",
      method: req.method ?? "GET",
      path: resolvedPath,
      headers: resolvedHeaders,
      body: resolvedBody,
      timestamp: new Date(),
    };
    requests.push(egressReq);
    console.log(`[mock] Egress ${egressReq.method} ${egressReq.path}`);

    if (req.url?.startsWith("/api/egress/resolve-secret")) {
      const secretKey = (resolvedBody as { secretKey?: string } | undefined)?.secretKey;
      const value = secretKey ? (resolveSecret(secretKey) ?? null) : null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ value }));
      return;
    }

    for (const { pattern, handler } of egressConfig.handlers) {
      const matches =
        typeof pattern === "string" ? resolvedPath === pattern : pattern.test(resolvedPath);
      if (!matches) continue;
      const result = await handler(egressReq);
      if (result instanceof Response) {
        await sendResponse(res, result);
        return;
      }
      if (result && typeof result === "object" && "body" in result) {
        const response = result as {
          status?: number;
          headers?: Record<string, string>;
          body?: unknown;
        };
        res.writeHead(response.status ?? 200, {
          "Content-Type": "application/json",
          ...(response.headers ?? {}),
        });
        res.end(JSON.stringify(response.body ?? {}));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result ?? { ok: true }));
      return;
    }

    if (/models\.dev\/api\.json/.test(resolvedPath)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(modelsDevStub));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }

  return {
    get port() {
      return port;
    },
    get url() {
      return `http://localhost:${port}`;
    },
    requests,
    orpc: {
      getRequests(procedure) {
        return requests.filter(
          (req): req is OrpcRequest => req.type === "orpc" && req.procedure === procedure,
        );
      },
      setGetEnvResponse(response) {
        orpcConfig.getEnvResponse = response;
      },
      setReportStatusResponse(response) {
        orpcConfig.reportStatusResponse = response;
      },
    },
    egress: {
      getRequests(pathPattern) {
        return requests.filter((req): req is EgressRequest => {
          if (req.type !== "egress") return false;
          if (!pathPattern) return true;
          return typeof pathPattern === "string"
            ? req.path === pathPattern
            : pathPattern.test(req.path);
        });
      },
      onRequest(pattern, handler) {
        egressConfig.handlers.push({ pattern, handler });
      },
      setSecrets(secrets) {
        egressConfig.secrets = secrets;
      },
    },
    resetRequests() {
      requests.length = 0;
    },
    async start() {
      port = 16000 + Math.floor(Math.random() * 4000);
      server = createServer(async (req, res) => {
        if (req.url?.startsWith("/api/orpc")) {
          await handleOrpc(req, res);
          return;
        }
        const body = await readRequestBody(req);
        await handleEgress(req, res, body);
      });
      await new Promise<void>((resolve) => {
        server!.listen(port, resolve);
      });
    },
    async close() {
      if (!server) return;
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
      });
      server = null;
    },
  };
}
