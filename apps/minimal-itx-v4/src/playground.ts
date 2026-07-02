import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";
import type { CfExecutionContext, Session } from "./types.ts";
import { TRUSTED_INTERNAL_ITX_TOKEN } from "./auth.ts";
import { UnauthenticatedItxRpcTarget } from "./rpc-targets.ts";

type PlaygroundCommandRequest = {
  code?: unknown;
};

const PLAYGROUND_DEMO_PROJECT_ID = "playground-demo-default";
const PLAYGROUND_DEMO_PROJECT_SLUG = "playground-demo-default";
const PLAYGROUND_DEMO_SECRET_PATH = "/secrets/playground/api-token";
const PLAYGROUND_DEMO_SECRET_MATERIAL = "demo-secret-material";
const POSTMAN_ECHO_GET_URL = "https://postman-echo.com/get?source=itx-playground";
const POSTMAN_ECHO_HEADERS_URL = "https://postman-echo.com/headers";
const POSTMAN_ECHO_POST_URL = "https://postman-echo.com/post";
const BLIND_RELAY_SKIP_TLS_VERIFY_HEADER = "x-itx-blind-relay-insecure-skip-tls-verify";
const ITX_EGRESS_CLI_DEPENDENCIES =
  "tsx@4.21.0 trpc-cli@0.15.1 @orpc/server@1.14.6 zod@4.4.3 capnweb@0.8.0 ws@8.19.0";

const PLAYGROUND_DEMO_PHASES = [
  "idle",
  "cli_listening",
  "waiting_for_node_relay",
  "plain_intercept_saw_plaintext",
  "relay_connected",
  "encrypted_relay_observed",
  "secret_egress_relayed",
  "target_received_request",
  "relay_saw_ciphertext_only",
  "failed",
] as const;
type PlaygroundDemoPhase = (typeof PLAYGROUND_DEMO_PHASES)[number];

type PlaygroundDemoLogEntry = {
  at: string;
  detail?: unknown;
  message: string;
  phase: PlaygroundDemoPhase;
};

type PlaygroundDemoState = {
  demoId: string;
  logs: PlaygroundDemoLogEntry[];
  phase: PlaygroundDemoPhase;
  updatedAt: string;
};

export class PlaygroundDemoDurableObject extends DurableObject<Env> {
  #state: PlaygroundDemoState | undefined;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = playgroundDemoPath(url);

    if (path === "/status" && request.method === "GET") {
      return Response.json(await this.#readState());
    }

    if (path === "/reset" && request.method === "POST") {
      const state = this.#initialState();
      await this.#writeState(state);
      return Response.json(state);
    }

    if (path === "/events" && request.method === "POST") {
      const input = await request.json().catch(() => ({}));
      const entry: PlaygroundDemoLogEntry = {
        at: new Date().toISOString(),
        detail: isRecord(input) ? input.detail : undefined,
        message:
          isRecord(input) && typeof input.message === "string" ? input.message : "demo event",
        phase: demoPhase(isRecord(input) ? input.phase : undefined),
      };
      const current = await this.#readState();
      const state: PlaygroundDemoState = {
        demoId: current.demoId,
        logs: [entry, ...current.logs].slice(0, 80),
        phase: entry.phase,
        updatedAt: entry.at,
      };
      await this.#writeState(state);
      return Response.json(state);
    }

    return Response.json({ error: "not found" }, { status: 404 });
  }

  async #readState(): Promise<PlaygroundDemoState> {
    this.#state ??=
      (await this.ctx.storage.get<PlaygroundDemoState>("state")) ?? this.#initialState();
    return this.#state;
  }

  #initialState(): PlaygroundDemoState {
    return {
      demoId: this.ctx.id.name ?? "default",
      logs: [],
      phase: "idle",
      updatedAt: new Date().toISOString(),
    };
  }

  async #writeState(state: PlaygroundDemoState): Promise<void> {
    this.#state = state;
    await this.ctx.storage.put("state", state);
  }
}

export async function playgroundResponse(
  request: Request,
  env: Env,
  ctx: CfExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname === "/") {
    if (request.method !== "GET") {
      return Response.json({ error: "method not allowed" }, { status: 405 });
    }
    return htmlResponse(landingHtml(url.origin));
  }

  if (url.pathname === "/playground") {
    if (request.method !== "GET") {
      return Response.json({ error: "method not allowed" }, { status: 405 });
    }
    return htmlResponse(playgroundHtml(url.origin));
  }

  if (
    url.pathname === "/playground/itx-egress-cli.mts" ||
    url.pathname === "/playground/itx-egress-cli.ts" ||
    url.pathname === "/playground/blind-relay-proof.ts"
  ) {
    return new Response(itxEgressCliScript(), {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
      },
    });
  }

  if (url.pathname.startsWith("/playground/demo/")) {
    return env.PLAYGROUND_DEMO.getByName(playgroundDemoId(url)).fetch(request);
  }

  if (url.pathname === "/playground/target") {
    return playgroundTargetResponse(request, env);
  }

  if (url.pathname === "/playground/run") {
    if (request.method !== "POST") {
      return Response.json({ error: "method not allowed" }, { status: 405 });
    }
    return runPlaygroundCommand(request, ctx);
  }

  return null;
}

async function runPlaygroundCommand(request: Request, ctx: CfExecutionContext): Promise<Response> {
  let input: PlaygroundCommandRequest;
  try {
    input = (await request.json()) as PlaygroundCommandRequest;
  } catch {
    return Response.json({ error: "request body must be JSON" }, { status: 400 });
  }

  const parsed = parsePlaygroundCommandRequest(input);
  if (parsed instanceof Response) return parsed;

  const startedAt = Date.now();
  const session = new UnauthenticatedItxRpcTarget(new Headers(), ctx).authenticate({
    type: "trusted-internal",
    token: TRUSTED_INTERNAL_ITX_TOKEN,
  });
  const helpers = playgroundHelpers(new URL(request.url).origin);

  try {
    const result = await withTimeout(
      evaluatePlaygroundScript(parsed, session, helpers),
      20_000,
      "command timed out after 20s",
    );
    return Response.json({
      durationMs: Date.now() - startedAt,
      ok: true,
      result: await toJsonable(result),
    });
  } catch (error) {
    return Response.json(
      {
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        ok: false,
        stack: error instanceof Error ? error.stack : undefined,
      },
      { status: 500 },
    );
  }
}

function parsePlaygroundCommandRequest(input: PlaygroundCommandRequest): string | Response {
  if (typeof input.code === "string" && input.code.trim() !== "") return input.code;
  return Response.json({ error: "code is required" }, { status: 400 });
}

async function evaluatePlaygroundScript(
  code: string,
  session: Session,
  helpers: ReturnType<typeof playgroundHelpers>,
): Promise<unknown> {
  const project = await helpers.project(session);
  const execution = await project.runScript(wrapPlaygroundScript(code));
  return execution.result;
}

function wrapPlaygroundScript(code: string): string {
  return `async (itx) => {
  const script = (${code});
  if (typeof script !== "function") {
    throw new Error("Playground script must be an async function, e.g. async (itx) => { ... }");
  }
  return await toJsonable(await script(itx));

  async function toJsonable(value) {
    if (value instanceof Response) return await responseSummary(value);
    if (value instanceof Request) {
      return {
        body: await value.clone().text(),
        headers: headersToObject(value.headers),
        method: value.method,
        url: value.url,
      };
    }
    if (value instanceof Headers) return headersToObject(value);
    if (value instanceof Uint8Array) return Array.from(value);
    if (value instanceof Error) return { message: value.message, stack: value.stack };
    if (Array.isArray(value)) return await Promise.all(value.map(toJsonable));
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        await Promise.all(
          Object.entries(value).map(async ([key, item]) => [key, await toJsonable(item)]),
        ),
      );
    }
    return value ?? null;
  }

  async function responseSummary(response) {
    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
    return {
      body,
      headers: headersToObject(response.headers),
      status: response.status,
      statusText: response.statusText,
    };
  }

  function headersToObject(headers) {
    return Object.fromEntries([...headers.entries()].sort(([left], [right]) => left.localeCompare(right)));
  }
}`;
}

function playgroundHelpers(origin: string) {
  return {
    origin,
    async project(session: Session) {
      return await session.projects.create({
        projectId: PLAYGROUND_DEMO_PROJECT_ID,
        slug: PLAYGROUND_DEMO_PROJECT_SLUG,
      });
    },
    deployedListenerCommand() {
      return [
        'tmp="$(mktemp -d)"',
        '&& cd "$tmp"',
        "&& npm init -y >/dev/null",
        `&& npm install ${ITX_EGRESS_CLI_DEPENDENCIES} >/dev/null`,
        `&& curl -fsS ${origin}/playground/itx-egress-cli.mts -o itx-egress-cli.mts`,
        `&& npx tsx itx-egress-cli.mts listen --base-url ${origin} --demo-id default`,
      ].join(" ");
    },
  };
}

function itxEgressCliScript(): string {
  return String.raw`import net from "node:net";
import { os } from "@orpc/server";
import { createCli } from "trpc-cli";
import { z } from "zod";
import { RpcTarget, newWebSocketRpcSession } from "capnweb";
import WebSocket from "ws";

const DEFAULT_BASE_URL = "https://minimal-itx-v4-blind-relay-poc.iterate-dev-preview.workers.dev";
const TRUSTED_INTERNAL_ITX_TOKEN = "trusted-internal-itx-token";
const PLAYGROUND_DEMO_PROJECT_ID = "playground-demo-default";
const PLAYGROUND_DEMO_PROJECT_SLUG = "playground-demo-default";

class BlindRelayConnectionTarget extends RpcTarget {
  #observation;
  #onClose;
  #readQueue = [];
  #readWaiters = [];
  #socket;
  #closed = false;
  #error;

  constructor({ observation, onClose, socket }) {
    super();
    this.#observation = observation;
    this.#onClose = onClose;
    this.#socket = socket;

    socket.on("data", (chunk) => {
      const bytes = new Uint8Array(chunk);
      observation.bytesTargetToWorker += bytes.byteLength;
      observation.targetToWorkerChunks.push(bytes.slice());
      if (observation.firstTargetToWorker.byteLength === 0) {
        observation.firstTargetToWorker = bytes.slice(0, 96);
      }
      const waiter = this.#readWaiters.shift();
      if (waiter === undefined) this.#readQueue.push(bytes);
      else waiter.resolve(bytes);
    });
    socket.once("close", () => this.#finishReads(null));
    socket.once("end", () => this.#finishReads(null));
    socket.once("error", (error) => {
      this.#error = error;
      this.#finishReads(error);
    });
  }

  async read() {
    if (this.#readQueue.length > 0) return this.#readQueue.shift();
    if (this.#error !== undefined) throw this.#error;
    if (this.#closed) return null;
    return await new Promise((resolve, reject) => {
      this.#readWaiters.push({ reject, resolve });
    });
  }

  async write(chunk) {
    this.#observation.bytesWorkerToTarget += chunk.byteLength;
    this.#observation.workerToTargetChunks.push(chunk.slice());
    if (this.#observation.firstWorkerToTarget.byteLength === 0) {
      this.#observation.firstWorkerToTarget = chunk.slice(0, 2048);
    }
    await new Promise((resolve, reject) => {
      this.#socket.write(chunk, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async close() {
    this.#socket.destroy();
    this.#finishReads(null);
  }

  #finishReads(error) {
    if (this.#closed) return;
    this.#closed = true;
    this.#onClose?.(this.#observation);
    for (const waiter of this.#readWaiters.splice(0)) {
      if (error === null) waiter.resolve(null);
      else waiter.reject(error);
    }
  }
}

class BlindRelayTarget extends RpcTarget {
  observations = [];
  #sockets = new Set();
  #logRequests;

  constructor({ logRequests = false } = {}) {
    super();
    this.#logRequests = logRequests;
  }

  async dial({ host, port }) {
    const socket = net.connect({ host, port });
    this.#sockets.add(socket);
    socket.once("close", () => this.#sockets.delete(socket));

    const observation = {
      bytesTargetToWorker: 0,
      bytesWorkerToTarget: 0,
      closedAt: undefined,
      connectedAt: undefined,
      firstTargetToWorker: new Uint8Array(),
      firstWorkerToTarget: new Uint8Array(),
      host,
      id: this.observations.length + 1,
      localAddress: undefined,
      localPort: undefined,
      port,
      remoteAddress: undefined,
      remotePort: undefined,
      startedAt: new Date().toISOString(),
      targetToWorkerChunks: [],
      workerToTargetChunks: [],
    };
    this.observations.push(observation);
    if (this.#logRequests) {
      console.log("[encrypted request #" + observation.id + "] dial " + host + ":" + port);
    }

    socket.once("connect", () => {
      observation.connectedAt = new Date().toISOString();
      observation.localAddress = socket.localAddress;
      observation.localPort = socket.localPort;
      observation.remoteAddress = socket.remoteAddress;
      observation.remotePort = socket.remotePort;
      if (this.#logRequests) {
        console.log(
          "[encrypted request #" +
            observation.id +
            "] connected remote=" +
            observation.remoteAddress +
            ":" +
            observation.remotePort,
        );
      }
    });

    return new BlindRelayConnectionTarget({
      observation,
      onClose: (closedObservation) => {
        closedObservation.closedAt = new Date().toISOString();
        if (this.#logRequests) printRequestLog("encrypted relay request", [summarizeEncryptedObservation(closedObservation)]);
      },
      socket,
    });
  }

  dispose() {
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
  }
}


async function runPlainInterceptListen({
  baseUrl: inputBaseUrl,
  demoId = "default",
}) {
  const baseUrl = normalizeBaseUrl(inputBaseUrl || process.env.ITX_BASE_URL || DEFAULT_BASE_URL);
  const session = connectItx(baseUrl);
  let interceptHandle;
  const requestLog = [];

  try {
    const root = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });
    const project = await sharedDemoProject(root, demoId);
    interceptHandle = await project.egress.intercept(async (request) => {
      const intercepted = {
        body: await request.text(),
        headers: headersToObject(request.headers),
        method: request.method,
        note: "Plain listener sees the request before any secret substitution or outbound fetch.",
        url: request.url,
      };
      requestLog.push(intercepted);
      printRequestLog("plain listener request", [intercepted]);
      await postEvent(baseUrl, demoId, {
        phase: "plain_intercept_saw_plaintext",
        message: "Local plain listener saw an outbound ITX request.",
        detail: intercepted,
      });
      return Response.json({
        interceptedBy: "local-node-plain-listener",
        request: intercepted,
        requestNumber: requestLog.length,
      });
    });

    await postEvent(baseUrl, demoId, {
      phase: "cli_listening",
      message: "Local plain interceptor is listening on shared project " + PLAYGROUND_DEMO_PROJECT_ID + ".",
      detail: { mode: "plain-intercept-listen", projectId: PLAYGROUND_DEMO_PROJECT_ID },
    });
    console.log("Plain intercept listener installed.");
    console.log("Worker: " + baseUrl);
    console.log("Shared project: " + PLAYGROUND_DEMO_PROJECT_ID);
    console.log("Open " + new URL("/playground", baseUrl).toString() + " and click fetch buttons.");
    console.log("This mode prints full request URL, method, headers, and body. Press Ctrl+C to stop.");
    await waitForShutdown();
    return { mode: "plain-intercept-listen", requestLog };
  } finally {
    if (interceptHandle !== undefined) await interceptHandle.release().catch(() => {});
    session[Symbol.dispose]?.();
  }
}

async function runBlindRelayListen({
  baseUrl: inputBaseUrl,
  demoId = "default",
}) {
  const baseUrl = normalizeBaseUrl(inputBaseUrl || process.env.ITX_BASE_URL || DEFAULT_BASE_URL);
  const relay = new BlindRelayTarget({ logRequests: true });
  const session = connectItx(baseUrl);
  let relayHandle;

  try {
    const root = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });
    const project = await sharedDemoProject(root, demoId);
    relayHandle = await project.egress.useBlindRelayForSecretEgress(relay);
    await postEvent(baseUrl, demoId, {
      phase: "cli_listening",
      message: "Local blind relay is listening on shared project " + PLAYGROUND_DEMO_PROJECT_ID + ".",
      detail: { mode: "blind-relay-listen", projectId: PLAYGROUND_DEMO_PROJECT_ID },
    });
    console.log("Blind relay listener installed.");
    console.log("Worker: " + baseUrl);
    console.log("Shared project: " + PLAYGROUND_DEMO_PROJECT_ID);
    console.log("Open " + new URL("/playground", baseUrl).toString() + " and click a secret-bearing fetch button.");
    console.log("This mode prints host/SNI/IP/TLS byte metadata only. Press Ctrl+C to stop.");
    await waitForShutdown();
    const requestLog = relay.observations.map(summarizeEncryptedObservation);
    printRequestLog("encrypted relay request log", requestLog);
    return { mode: "blind-relay-listen", requestLog };
  } finally {
    if (relayHandle !== undefined) await relayHandle.release().catch(() => {});
    relay.dispose();
    session[Symbol.dispose]?.();
  }
}

function connectItx(baseUrl) {
  const url = new URL("/api/itx", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url, { handshakeTimeout: 10_000 });
  return newWebSocketRpcSession(socket);
}

async function postEvent(baseUrl, demoId, event) {
  const url = new URL("/playground/demo/" + encodeURIComponent(demoId) + "/events", baseUrl);
  const response = await fetch(url, {
    body: JSON.stringify(event),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    console.warn("failed to update playground demo status:", response.status, await response.text());
  }
}

function normalizeBaseUrl(input) {
  const url = new URL(input);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function headersToObject(headers) {
  return Object.fromEntries([...headers.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

async function sharedDemoProject(root, demoId) {
  const suffix = String(demoId || "default").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40) || "default";
  return await root.projects.create({
    projectId: suffix === "default" ? PLAYGROUND_DEMO_PROJECT_ID : "playground-demo-" + suffix,
    slug: suffix === "default" ? PLAYGROUND_DEMO_PROJECT_SLUG : "playground-demo-" + suffix,
  });
}

function printRequestLog(title, entries) {
  console.log("");
  console.log(title + " (" + entries.length + ")");
  console.log(JSON.stringify(entries, null, 2));
  console.log("");
}

function summarizeEncryptedObservation(observation) {
  return {
    bytesTargetToWorker: observation.bytesTargetToWorker,
    bytesWorkerToTarget: observation.bytesWorkerToTarget,
    closedAt: observation.closedAt,
    connectedAt: observation.connectedAt,
    firstTargetToWorkerBytes: bytesPreview(observation.firstTargetToWorker),
    firstWorkerToTargetBytes: bytesPreview(observation.firstWorkerToTarget),
    id: observation.id,
    localAddress: observation.localAddress,
    localPort: observation.localPort,
    note: "Encrypted relay mode does not expose HTTP headers or body.",
    requestedHost: observation.host,
    requestedPort: observation.port,
    remoteAddress: observation.remoteAddress,
    remotePort: observation.remotePort,
    sni: extractTlsClientHelloSni(observation.firstWorkerToTarget),
    startedAt: observation.startedAt,
  };
}

function bytesPreview(bytes, max = 32) {
  return Array.from(bytes.slice(0, max))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ");
}

function extractTlsClientHelloSni(bytes) {
  try {
    if (bytes.length < 5 || bytes[0] !== 22) return null;
    let offset = 5;
    if (bytes[offset] !== 1) return null;
    offset += 4;
    offset += 2 + 32;
    const sessionIdLength = bytes[offset];
    offset += 1 + sessionIdLength;
    const cipherSuitesLength = (bytes[offset] << 8) | bytes[offset + 1];
    offset += 2 + cipherSuitesLength;
    const compressionMethodsLength = bytes[offset];
    offset += 1 + compressionMethodsLength;
    const extensionsLength = (bytes[offset] << 8) | bytes[offset + 1];
    offset += 2;
    const extensionsEnd = offset + extensionsLength;
    while (offset + 4 <= extensionsEnd) {
      const type = (bytes[offset] << 8) | bytes[offset + 1];
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      offset += 4;
      if (type === 0) {
        let nameOffset = offset + 2;
        const listEnd = offset + length;
        while (nameOffset + 3 <= listEnd) {
          const nameType = bytes[nameOffset];
          const nameLength = (bytes[nameOffset + 1] << 8) | bytes[nameOffset + 2];
          nameOffset += 3;
          if (nameType === 0) {
            return Buffer.from(bytes.slice(nameOffset, nameOffset + nameLength)).toString("utf8");
          }
          nameOffset += nameLength;
        }
      }
      offset += length;
    }
  } catch {
    return null;
  }
  return null;
}

async function waitForShutdown() {
  await new Promise((resolve) => {
    const done = () => resolve();
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

const router = os.router({
  listen: os
    .input(
      z.object({
        baseUrl: z.string().default(DEFAULT_BASE_URL).describe("Deployed Worker base URL"),
        demoId: z.string().default("default").describe("Playground demo id (matches the web page)"),
        mode: z
          .enum(["plain", "blind"])
          .describe(
            "plain = see the full request (URL, method, headers, body); blind = see only encrypted TLS metadata (host, SNI, IP, byte counts)",
          ),
      }),
    )
    .handler(async ({ input }) => {
      if (input.mode === "plain") return await runPlainInterceptListen(input);
      return await runBlindRelayListen(input);
    }),
});

void createCli({ name: "itx-egress-demo", router }).run({ prompts: true });
`;
}

async function playgroundTargetResponse(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const body = await request.text();
  const clientIp = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-real-ip");
  const payload = {
    body,
    clientIp,
    headers: headersToObject(request.headers),
    method: request.method,
    note: "This is a simple HTTPS target hosted by the same deployed Worker for ITX playground egress calls.",
    url: request.url,
  };
  const demoId = url.searchParams.get("demo");
  if (demoId !== null && demoId.trim() !== "") {
    await env.PLAYGROUND_DEMO.getByName(demoId).fetch(
      new Request(new URL(`/playground/demo/${demoId}/events`, url.origin), {
        body: JSON.stringify({
          detail: {
            authorization: payload.headers.authorization,
            body,
            clientIp,
            proofHeader: payload.headers["x-itx-egress-proof"],
            url: request.url,
          },
          message: `Target received relayed HTTPS request${clientIp === null ? "" : ` from ${clientIp}`}.`,
          phase: "target_received_request",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
  }

  return Response.json(payload, {
    headers: {
      "cache-control": "no-store",
    },
  });
}

async function toJsonable(value: unknown): Promise<unknown> {
  if (value instanceof Response) {
    return responseSummary(value);
  }
  if (value instanceof Request) {
    return {
      body: await value.clone().text(),
      headers: headersToObject(value.headers),
      method: value.method,
      url: value.url,
    };
  }
  if (value instanceof Headers) return headersToObject(value);
  if (value instanceof Uint8Array) return Array.from(value);
  if (value instanceof Error) return { message: value.message, stack: value.stack };
  return value;
}

async function responseSummary(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  return {
    body,
    headers: headersToObject(response.headers),
    status: response.status,
    statusText: response.statusText,
  };
}

function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function playgroundDemoId(url: URL): string {
  const [, , , demoId] = url.pathname.split("/");
  return demoId === undefined || demoId.trim() === "" ? "default" : demoId;
}

function playgroundDemoPath(url: URL): string {
  const [, , , _demoId, ...rest] = url.pathname.split("/");
  return `/${rest.join("/")}`;
}

function demoPhase(input: unknown): PlaygroundDemoPhase {
  return PLAYGROUND_DEMO_PHASES.includes(input as PlaygroundDemoPhase)
    ? (input as PlaygroundDemoPhase)
    : "idle";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" },
  });
}

function landingHtml(origin: string): string {
  const playgroundUrl = escapeHtml(new URL("/playground", origin).toString());
  const pageDebuggingUrl = escapeHtml(new URL("/page-debugging", origin).toString());
  const clientModuleUrl = escapeHtml(new URL("/page-debugging/client.mjs", origin).toString());
  const blindRelayCode = escapeHtml(
    [
      "// A client process lends the project a TCP dialer capability:",
      "using handle = await project.egress.useBlindRelayForSecretEgress(relay);",
      "",
      "// From then on the worker sends every outbound request through that",
      "// socket as raw TLS. It substitutes secrets first, so the relay only",
      "// ever moves ciphertext — never the request, body, or secret:",
      'await itx.egress.fetch(new Request("https://api.example.com/me", {',
      "  headers: {",
      "    authorization: 'Bearer getSecret({ path: \"/secrets/api-token\" })',",
      "  },",
      "}));",
      "",
      "// `relay` is any object shaped like:",
      "//   { dial({ host, port }) => { read(), write(bytes), close() } }",
    ].join("\n"),
  );
  const pageDebuggingCode = escapeHtml(
    [
      "// A browser tab lends the project a live DOM handle by mounting PageTools:",
      `const { connectPageTools } = await import("${new URL("/page-debugging/client.mjs", origin).toString()}");`,
      "await connectPageTools({ connectUrl, token });",
      "",
      "// The worker (or an agent) resolves the debugPage capability and drives",
      "// the tab remotely, using Testing-Library-style queries:",
      "const page = agentProject.debugPage;",
      'await page.getByRole("button", { name: "Increment counter" }).click();',
      'await page.getByLabelText("Message").fill("hello from ITX");',
      'const shot = await page.screenshot({ mode: "auto" });',
    ].join("\n"),
  );
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ITX Capability Demos</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
    }
    body { margin: 0; background: #f6f7f9; color: #14171f; }
    main { max-width: 900px; margin: 0 auto; padding: 40px 28px 64px; }
    h1 { margin: 0 0 6px; font-size: 30px; }
    .lede { margin: 0 0 28px; color: #4f5a68; font-size: 16px; }
    .card {
      background: #fff;
      border: 1px solid #d8dde6;
      border-radius: 10px;
      padding: 20px 22px;
      margin: 0 0 20px;
    }
    .card h2 { margin: 0 0 4px; font-size: 20px; }
    .card p { margin: 0 0 14px; color: #4f5a68; }
    .card a.open {
      display: inline-block;
      background: #1463ff;
      color: #fff;
      text-decoration: none;
      padding: 8px 14px;
      border-radius: 6px;
      font-size: 14px;
      margin-bottom: 14px;
    }
    pre {
      margin: 0;
      padding: 14px;
      border-radius: 8px;
      background: #0f1720;
      color: #e8edf5;
      overflow: auto;
      font: 12.5px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    .url { color: #647084; font-size: 13px; word-break: break-all; }
  </style>
</head>
<body>
  <main>
    <h1>ITX capability demos</h1>
    <p class="lede">Two proofs of concept for one idea: a client process lends the project a
      <strong>live capability</strong>, and the worker (or an agent running inside it) calls that
      capability back over RPC as if it were local. One demo lends a TCP socket; the other lends a
      browser tab.</p>

    <section class="card">
      <h2>Blind relay egress</h2>
      <p>The client provides a <code>dial()</code> TCP capability. The worker materializes secrets and
        runs TLS itself, pushing only encrypted records through the client's socket — so the relay
        moves bytes but never sees the request, body, or substituted secret.</p>
      <a class="open" href="${playgroundUrl}">Open the playground →</a>
      <div class="url">${playgroundUrl}</div>
      <pre>${blindRelayCode}</pre>
    </section>

    <section class="card">
      <h2>Page debugging</h2>
      <p>A browser tab provides a <code>debugPage()</code> DOM capability by mounting PageTools over
        Cap'n Web. The worker, or the demo page acting as an agent, drives that tab remotely: snapshot
        the DOM, click, fill, screenshot.</p>
      <a class="open" href="${pageDebuggingUrl}">Open the page debugging demo →</a>
      <div class="url">${pageDebuggingUrl}</div>
      <pre>${pageDebuggingCode}</pre>
      <p class="url" style="margin-top:12px">Client module: ${clientModuleUrl}</p>
    </section>
  </main>
</body>
</html>`;
}

function playgroundHtml(origin: string): string {
  const examples = JSON.stringify(playgroundExamples(origin));
  const blindRelayCommand = escapeHtml(playgroundHelpers(origin).deployedListenerCommand());
  const blindRelayScriptUrl = escapeHtml(
    new URL("/playground/itx-egress-cli.mts", origin).toString(),
  );
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Blind Relay POC Playground</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.45;
    }
    body {
      margin: 0;
      background: #f6f7f9;
      color: #14171f;
    }
    main {
      max-width: 1180px;
      margin: 0 auto;
      padding: 28px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 28px;
      letter-spacing: 0;
    }
    p {
      margin: 0 0 16px;
      color: #4f5a68;
    }
    .layout {
      display: grid;
      grid-template-columns: 260px minmax(0, 1fr);
      gap: 18px;
      align-items: start;
    }
    .panel {
      background: #fff;
      border: 1px solid #d8dde6;
      border-radius: 8px;
    }
    .examples {
      padding: 10px;
    }
    .example {
      width: 100%;
      display: block;
      margin: 0 0 8px;
      padding: 10px;
      border: 1px solid #c9d0dc;
      border-radius: 6px;
      background: #f9fafb;
      color: #172033;
      text-align: left;
      cursor: pointer;
      font: inherit;
    }
    .example.active {
      border-color: #1463ff;
      background: #eef4ff;
    }
    .example span {
      display: block;
      margin-top: 4px;
      color: #647084;
      font-size: 12px;
    }
    .editor {
      display: grid;
      grid-template-rows: auto minmax(320px, 46vh) auto auto minmax(180px, 30vh);
      min-width: 0;
    }
    .bar {
      display: flex;
      gap: 10px;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      border-bottom: 1px solid #d8dde6;
    }
    .bar:last-of-type {
      border-top: 1px solid #d8dde6;
      border-bottom: 0;
    }
    button.run {
      border: 0;
      border-radius: 6px;
      background: #1463ff;
      color: white;
      padding: 9px 14px;
      font: inherit;
      cursor: pointer;
    }
    button.run:disabled {
      opacity: 0.6;
      cursor: wait;
    }
    textarea, pre {
      margin: 0;
      border: 0;
      padding: 14px;
      resize: vertical;
      font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      background: #0f1720;
      color: #e8edf5;
      overflow: auto;
      white-space: pre-wrap;
    }
    textarea:focus {
      outline: 2px solid #1463ff;
      outline-offset: -2px;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    }
    .meta {
      font-size: 13px;
      color: #647084;
    }
    .warning {
      border-left: 4px solid #c77d00;
      background: #fff8e8;
      padding: 10px 12px;
      margin: 18px 0;
      color: #4c3700;
    }
    .demo-box {
      display: grid;
      gap: 10px;
      margin: 18px 0;
      padding: 12px;
    }
    .demo-box h2,
    .demo-status h2 {
      margin: 0;
      font-size: 18px;
    }
    .command {
      display: block;
      max-height: 150px;
      border-radius: 6px;
      padding: 12px;
      background: #0f1720;
      color: #e8edf5;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    }
    .command-row {
      display: grid;
      gap: 8px;
    }
    .demo-status {
      display: grid;
      gap: 8px;
      margin: 18px 0;
      padding: 12px;
    }
    .status-row {
      display: flex;
      gap: 10px;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
    }
    .phase {
      font-weight: 700;
    }
    .proof-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .proof-item {
      border: 1px solid #d8dde6;
      border-radius: 6px;
      padding: 8px;
      background: #fbfcfe;
      min-width: 0;
    }
    .proof-item small {
      display: block;
      color: #647084;
      margin-bottom: 4px;
    }
    .proof-item code {
      word-break: break-word;
    }
    .logs {
      display: grid;
      gap: 8px;
      max-height: 240px;
      overflow: auto;
    }
    .log {
      border-top: 1px solid #d8dde6;
      padding-top: 8px;
      font-size: 13px;
    }
    .log small {
      color: #647084;
    }
    .summary {
      border-top: 1px solid #d8dde6;
      padding: 10px 12px;
      color: #172033;
      font-size: 13px;
      min-height: 22px;
    }
    .summary code {
      background: #eef1f5;
      border-radius: 4px;
      padding: 1px 4px;
    }
    @media (max-width: 780px) {
      main { padding: 18px; }
      .layout { grid-template-columns: 1fr; }
      .editor { grid-template-rows: auto 360px auto auto 280px; }
      .proof-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <h1>ITX Egress Playground</h1>
    <p><a href="/">← Back to the capability demos</a></p>
    <p>Run ITX fetch scripts against this deployed Worker, then watch a local listener see the same egress from the other side. Every script is an <code>async (itx) =&gt; { ... }</code> function.</p>
    <div class="warning">Demo-only: anyone with this URL can create throwaway projects on this dev Worker. Do not enter real secrets.</div>
    <section class="panel demo-box">
      <h2>Run a local egress listener</h2>
      <p>This downloads a self-contained TypeScript CLI into a temp directory, installs pinned deps, then asks you to pick one of two modes. Requires Node.js 20+ and npm.</p>
      <ul>
        <li><strong>plain</strong> — installs an egress interceptor and prints the full request (URL, method, headers, body) for every fetch you trigger below. Runs before secret substitution, so it sees <code>getSecret(...)</code> placeholders.</li>
        <li><strong>blind</strong> — installs a blind relay and prints only encrypted TLS metadata (host, SNI, remote IP, byte counts). The worker substitutes secrets and terminates TLS itself, so the relay never sees plaintext.</li>
      </ul>
      <p class="meta">Both attach to the shared project <code>${PLAYGROUND_DEMO_PROJECT_ID}</code> and stay listening until Ctrl+C. Guaranteed demo secret: <code>${PLAYGROUND_DEMO_SECRET_PATH}</code> = <code>${PLAYGROUND_DEMO_SECRET_MATERIAL}</code>.</p>
      <div class="command-row">
        <button class="example" id="copy-command" type="button">Copy command</button>
        <code class="command" id="relay-command">${blindRelayCommand}</code>
      </div>
      <p class="meta">Raw script: <a href="${blindRelayScriptUrl}">${blindRelayScriptUrl}</a></p>
    </section>
    <section class="panel demo-status">
      <h2>Live relay demo state</h2>
      <div class="status-row">
        <div>Demo state: <span class="phase" id="demo-phase">loading</span></div>
        <button class="example" id="reset-demo" type="button">Reset log</button>
      </div>
      <div class="meta" id="demo-updated">Waiting for status...</div>
      <div class="proof-grid" id="demo-proof"></div>
      <div class="logs" id="demo-logs"></div>
    </section>
    <div class="layout">
      <aside class="panel examples" id="examples"></aside>
      <section class="panel editor">
        <div class="bar">
          <strong id="title">ITX Script</strong>
          <span class="meta" id="origin">${escapeHtml(origin)}</span>
        </div>
        <textarea id="code" spellcheck="false"></textarea>
        <div class="bar">
          <span class="meta" id="status">Ready</span>
          <button class="run" id="run">Run</button>
        </div>
        <div class="summary" id="summary">Select an ITX script and run it. If the local CLI is listening, it will log the request.</div>
        <pre id="output">{}</pre>
      </section>
    </div>
  </main>
  <script>
    const examples = ${examples};
    const examplesEl = document.querySelector("#examples");
    const code = document.querySelector("#code");
    const output = document.querySelector("#output");
    const summary = document.querySelector("#summary");
    const statusEl = document.querySelector("#status");
    const title = document.querySelector("#title");
    const run = document.querySelector("#run");
    const demoPhase = document.querySelector("#demo-phase");
    const demoUpdated = document.querySelector("#demo-updated");
    const demoProof = document.querySelector("#demo-proof");
    const demoLogs = document.querySelector("#demo-logs");
    const resetDemo = document.querySelector("#reset-demo");
    const copyCommand = document.querySelector("#copy-command");
    const relayCommand = document.querySelector("#relay-command");
    let selected = 0;

    function select(index) {
      selected = index;
      code.value = examples[index].code;
      title.textContent = examples[index].title;
      for (const [buttonIndex, button] of [...examplesEl.querySelectorAll("button")].entries()) {
        button.classList.toggle("active", buttonIndex === index);
      }
    }

    examples.forEach((example, index) => {
      const button = document.createElement("button");
      button.className = "example";
      button.type = "button";
      button.textContent = example.title;
      const description = document.createElement("span");
      description.textContent = example.description;
      button.append(description);
      button.addEventListener("click", () => select(index));
      examplesEl.append(button);
    });

    run.addEventListener("click", async () => {
      run.disabled = true;
      statusEl.textContent = "Running...";
      output.textContent = "";
      summary.textContent = "Running selected ITX script...";
      try {
        const response = await fetch("/playground/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: code.value }),
        });
        const body = await response.json();
        output.textContent = JSON.stringify(body, null, 2);
        summary.innerHTML = summarizeResult(body);
        statusEl.textContent = response.ok ? "Done" : "Failed";
      } catch (error) {
        output.textContent = String(error && error.stack ? error.stack : error);
        summary.textContent = "Command failed before it returned a JSON result.";
        statusEl.textContent = "Failed";
      } finally {
        run.disabled = false;
      }
    });

    resetDemo.addEventListener("click", async () => {
      await fetch("/playground/demo/default/reset", { method: "POST" });
      await refreshDemoStatus();
    });

    copyCommand.addEventListener("click", async () => {
      await navigator.clipboard.writeText(relayCommand.textContent || "");
      copyCommand.textContent = "Copied";
      setTimeout(() => {
        copyCommand.textContent = "Copy command";
      }, 1200);
    });

    function summarizeResult(body) {
      if (!body || !body.ok) return escapeHtml(body && body.error ? body.error : "Command failed.");
      const result = body.result || {};
      switch (examples[selected].title) {
        case "Fetch Headers With Secret":
        case "POST With Secret":
        case "Hosted Target With Secret": {
          const responseBody = result.response && result.response.body;
          const headers = responseBody && (responseBody.headers || (responseBody.request && responseBody.request.headers));
          const auth = headers && (headers.authorization || headers["x-itx-egress-proof"]);
          const used = result.secret && result.secret.audit && result.secret.audit.usedCount;
          return "Target received materialized auth <code>" + escapeHtml(String(auth || "missing")) + "</code>; audit usedCount is <code>" + escapeHtml(String(used ?? "pending")) + "</code>.";
        }
        case "Fetch Postman GET":
        case "Fetch Postman POST":
          return "Postman Echo returned the outbound request details. A local plain listener prints these request headers and body; a blind listener prints only encrypted metadata.";
        case "Describe Demo Project":
          return "Running inside shared project <code>" + escapeHtml(String(result.id || result.slug || "unknown")) + "</code>.";
        default:
          return "Command returned successfully.";
      }
    }

    function escapeHtml(value) {
      return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    }

    async function refreshDemoStatus() {
      try {
        const response = await fetch("/playground/demo/default/status", { cache: "no-store" });
        const state = await response.json();
        demoPhase.textContent = phaseLabel(state.phase);
        demoUpdated.textContent = "Updated " + new Date(state.updatedAt).toLocaleTimeString();
        renderProofSummary(state.logs || []);
        demoLogs.innerHTML = "";
        for (const entry of state.logs || []) {
          const item = document.createElement("div");
          item.className = "log";
          const detail = entry.detail === undefined ? "" : "<pre>" + escapeHtml(JSON.stringify(entry.detail, null, 2)) + "</pre>";
          item.innerHTML = "<small>" + escapeHtml(new Date(entry.at).toLocaleTimeString()) + " · " + escapeHtml(phaseLabel(entry.phase)) + "</small><div>" + escapeHtml(entry.message) + "</div>" + detail;
          demoLogs.append(item);
        }
        if ((state.logs || []).length === 0) {
          demoLogs.textContent = "No relay script has reported status yet.";
        }
      } catch (error) {
        demoPhase.textContent = "unreachable";
        demoUpdated.textContent = String(error && error.message ? error.message : error);
      }
    }

    function phaseLabel(phase) {
      const labels = {
        idle: "Idle",
        cli_listening: "Local CLI is listening",
        waiting_for_node_relay: "Waiting for local Node relay",
        plain_intercept_saw_plaintext: "Plain interceptor saw plaintext",
        relay_connected: "Node relay connected",
        encrypted_relay_observed: "Encrypted relay observed request",
        secret_egress_relayed: "Secret egress relayed",
        target_received_request: "Target received request",
        relay_saw_ciphertext_only: "Done: relay only saw encrypted TLS bytes",
        failed: "Failed",
      };
      return labels[phase] || String(phase || "unknown");
    }

    function renderProofSummary(logs) {
      const target = logs.find((entry) => entry.phase === "target_received_request" && entry.detail);
      const secret = logs.find((entry) => entry.phase === "secret_egress_relayed" && entry.detail);
      const proof = logs.find((entry) => entry.phase === "relay_saw_ciphertext_only" && entry.detail);
      const targetIp = proof && proof.detail.targetClientIp || target && target.detail.clientIp || "pending";
      const receivedAuth = secret && secret.detail.headers && secret.detail.headers["x-itx-egress-proof"] || "pending";
      const relayDialed = proof && proof.detail.relayDialed || "pending";
      const absent = proof && proof.detail.hiddenStringsCheckedAbsent
        ? proof.detail.hiddenStringsCheckedAbsent.join(", ")
        : "pending";
      demoProof.innerHTML = [
        proofItem("Target saw client IP", targetIp),
        proofItem("Target received auth", receivedAuth),
        proofItem("Relay dialed", relayDialed),
        proofItem("Plaintext absent from relay", absent),
      ].join("");
    }

    function proofItem(label, value) {
      return '<div class="proof-item"><small>' + escapeHtml(label) + '</small><code>' + escapeHtml(String(value)) + '</code></div>';
    }

    select(selected);
    void refreshDemoStatus();
    setInterval(refreshDemoStatus, 1000);
  </script>
</body>
</html>`;
}

function playgroundExamples(origin: string) {
  return [
    {
      title: "Describe Demo Project",
      description: "Shows the project-scoped ITX object used by every snippet.",
      code: `async (itx) => {
  return await itx.describe();
}`,
    },
    {
      title: "Fetch Postman GET",
      description: "GET request to Postman Echo without a secret.",
      code: `async (itx) => {
  return await itx.egress.fetch(
    new Request("${POSTMAN_ECHO_GET_URL}", {
      headers: {
        "${BLIND_RELAY_SKIP_TLS_VERIFY_HEADER}": "1",
        "x-itx-demo": "postman-get",
      },
    }),
  );
}`,
    },
    {
      title: "Fetch Postman POST",
      description: "POST JSON to Postman Echo without a secret.",
      code: `async (itx) => {
  return await itx.egress.fetch(
    new Request("${POSTMAN_ECHO_POST_URL}", {
      method: "POST",
      headers: {
        "${BLIND_RELAY_SKIP_TLS_VERIFY_HEADER}": "1",
        "content-type": "application/json",
        "x-itx-demo": "postman-post-json",
      },
      body: JSON.stringify({ hello: "from ITX playground" }),
    }),
  );
}`,
    },
    {
      title: "Fetch Headers With Secret",
      description: "GET Postman Echo headers with the guaranteed demo secret.",
      code: `async (itx) => {
  const secret = itx.secrets.get("${PLAYGROUND_DEMO_SECRET_PATH}");
  await secret.update({
    material: "${PLAYGROUND_DEMO_SECRET_MATERIAL}",
    egress: { urls: ["${POSTMAN_ECHO_HEADERS_URL}"] },
  });

  return await itx.egress.fetch(
    new Request("${POSTMAN_ECHO_HEADERS_URL}", {
      headers: {
        authorization: 'Bearer getSecret({ path: "${PLAYGROUND_DEMO_SECRET_PATH}" })',
        "${BLIND_RELAY_SKIP_TLS_VERIFY_HEADER}": "1",
        "x-itx-demo": "postman-secret-headers",
      },
    }),
  );
}`,
    },
    {
      title: "POST With Secret",
      description: "POST to Postman Echo with the guaranteed demo secret header.",
      code: `async (itx) => {
  const secret = itx.secrets.get("${PLAYGROUND_DEMO_SECRET_PATH}");
  await secret.update({
    material: "${PLAYGROUND_DEMO_SECRET_MATERIAL}",
    egress: { urls: ["${POSTMAN_ECHO_POST_URL}"] },
  });

  return await itx.egress.fetch(
    new Request("${POSTMAN_ECHO_POST_URL}", {
      method: "POST",
      headers: {
        authorization: 'Bearer getSecret({ path: "${PLAYGROUND_DEMO_SECRET_PATH}" })',
        "${BLIND_RELAY_SKIP_TLS_VERIFY_HEADER}": "1",
        "content-type": "text/plain",
        "x-itx-demo": "postman-secret-post",
      },
      body: "body sent with a substituted secret header",
    }),
  );
}`,
    },
    {
      title: "Hosted Target With Secret",
      description: "POST to this Worker target so the page can log the received request.",
      code: `async (itx) => {
  const secret = itx.secrets.get("${PLAYGROUND_DEMO_SECRET_PATH}");
  await secret.update({
    material: "${PLAYGROUND_DEMO_SECRET_MATERIAL}",
    egress: { urls: ["${origin}/playground/target"] },
  });

  return await itx.egress.fetch(
    new Request("${origin}/playground/target?demo=default", {
      method: "POST",
      headers: {
        authorization: 'Bearer getSecret({ path: "${PLAYGROUND_DEMO_SECRET_PATH}" })',
        "content-type": "text/plain",
        "x-itx-demo": "hosted-secret-target",
      },
      body: "hosted target request with substituted secret",
    }),
  );
}`,
    },
  ].map((example) => ({
    ...example,
    code: example.code.replaceAll("${origin}", origin),
  }));
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
