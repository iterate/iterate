import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";
import type { CfExecutionContext, Secret, Session } from "./types.ts";
import { TRUSTED_INTERNAL_ITX_TOKEN } from "./auth.ts";
import { UnauthenticatedItxRpcTarget } from "./rpc-targets.ts";

type PlaygroundCommandRequest = {
  action?: unknown;
  code?: unknown;
  input?: unknown;
};

const PLAYGROUND_ACTIONS = [
  "whoami",
  "create-project",
  "project-egress",
  "plain-intercept-placeholder",
  "secret-egress",
  "blind-relay-proof-command",
] as const;
const ITX_EGRESS_CLI_DEPENDENCIES =
  "tsx@4.21.0 trpc-cli@0.15.1 @orpc/server@1.14.6 zod@4.4.3 capnweb@0.8.0 ws@8.19.0";

type PlaygroundDemoPhase =
  | "idle"
  | "waiting_for_node_relay"
  | "plain_intercept_saw_plaintext"
  | "relay_connected"
  | "secret_egress_relayed"
  | "target_received_request"
  | "relay_saw_ciphertext_only"
  | "failed";

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

  if (url.pathname === "/" || url.pathname === "/playground") {
    if (request.method !== "GET") {
      return Response.json({ error: "method not allowed" }, { status: 405 });
    }
    return new Response(playgroundHtml(url.origin), {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      },
    });
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

  if (typeof parsed.action !== "string" || parsed.action.trim() === "") {
    return Response.json({ error: "action is required" }, { status: 400 });
  }
  if (!PLAYGROUND_ACTIONS.includes(parsed.action as (typeof PLAYGROUND_ACTIONS)[number])) {
    return Response.json(
      {
        availableActions: PLAYGROUND_ACTIONS,
        error: `unknown action: ${parsed.action}`,
        ok: false,
      },
      { status: 400 },
    );
  }

  const startedAt = Date.now();
  const session = new UnauthenticatedItxRpcTarget(new Headers(), ctx).authenticate({
    type: "trusted-internal",
    token: TRUSTED_INTERNAL_ITX_TOKEN,
  });
  const helpers = playgroundHelpers(new URL(request.url).origin);

  try {
    const result = await withTimeout(
      runPlaygroundAction(parsed.action, parsed.input, session, helpers),
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
        stack:
          booleanParam(parsed.input, "debug", false) && error instanceof Error
            ? error.stack
            : undefined,
      },
      { status: 500 },
    );
  }
}

function parsePlaygroundCommandRequest(input: PlaygroundCommandRequest):
  | {
      action: string;
      input: Record<string, unknown>;
    }
  | Response {
  if (typeof input.action === "string") {
    return { action: input.action, input: objectInput(input.input) };
  }

  if (typeof input.code === "string") {
    try {
      const codeInput = JSON.parse(input.code) as unknown;
      if (isRecord(codeInput) && typeof codeInput.action === "string") {
        return {
          action: codeInput.action,
          input: objectInput(codeInput),
        };
      }
      return Response.json(
        { error: "JSON snippet must include an action string" },
        { status: 400 },
      );
    } catch {
      return Response.json(
        {
          error:
            "Cloudflare Workers disallow eval/code generation. Use one of the JSON action snippets in the textarea.",
        },
        { status: 400 },
      );
    }
  }

  return Response.json({ error: "action is required" }, { status: 400 });
}

async function runPlaygroundAction(
  action: string,
  input: Record<string, unknown>,
  session: Session,
  helpers: ReturnType<typeof playgroundHelpers>,
): Promise<unknown> {
  switch (action) {
    case "whoami":
      return {
        principal: session.whoami(),
        projects: session.projects.list(),
      };

    case "create-project": {
      const project = await session.projects.create({
        slug: helpers.projectSlug(stringParam(input, "prefix", "demo")),
      });
      return await project.describe();
    }

    case "project-egress": {
      const project = await session.projects.create({
        slug: helpers.projectSlug(stringParam(input, "prefix", "egress")),
      });
      const targetUrl = stringParam(input, "targetUrl", helpers.targetUrl());
      const response = await project.egress.fetch(
        new Request(targetUrl, {
          body: stringParam(input, "body", "hello from project egress"),
          headers: {
            "content-type": "text/plain",
            "x-itx-demo": "plain-egress",
          },
          method: "POST",
        }),
      );

      return {
        project: await project.describe(),
        response: await helpers.responseSummary(response),
        targetUrl,
      };
    }

    case "plain-intercept-placeholder": {
      const project = await session.projects.create({
        slug: helpers.projectSlug(stringParam(input, "prefix", "intercept")),
      });
      const targetUrl = stringParam(input, "targetUrl", helpers.targetUrl());
      const secretPath = stringParam(input, "secretPath", "/secrets/playground/intercept-token");
      const secret = project.secrets.get(secretPath);
      await secret.update({
        egress: { urls: [targetUrl] },
        material: stringParam(input, "secretMaterial", "intercept-demo-secret"),
      });
      await waitForSecretMaterial(secret);

      const intercept = await project.egress.intercept(async (request) =>
        Response.json({
          body: await request.text(),
          headers: headersToObject(request.headers),
          intercepted: true,
          note: "Plain intercept runs before secret substitution, so it sees the getSecret(...) placeholder, not material.",
          url: request.url,
        }),
      );
      try {
        const response = await project.egress.fetch(
          new Request(targetUrl, {
            body: stringParam(input, "body", "plain interceptor should see this body"),
            headers: {
              authorization: `Bearer getSecret({ path: "${secretPath}" })`,
              "content-type": "text/plain",
              "x-itx-demo": "plain-intercept-placeholder",
            },
            method: "POST",
          }),
        );

        return {
          project: await project.describe(),
          response: await helpers.responseSummary(response),
          secret: await secret.describe(),
          targetUrl,
        };
      } finally {
        await intercept.release();
      }
    }

    case "secret-egress": {
      const project = await session.projects.create({
        slug: helpers.projectSlug(stringParam(input, "prefix", "secret-egress")),
      });
      const targetUrl = stringParam(input, "targetUrl", helpers.targetUrl());
      const secretPath = stringParam(input, "secretPath", "/secrets/playground/api-token");
      const secretMaterial = stringParam(input, "secretMaterial", "demo-secret-material");
      const secret = project.secrets.get(secretPath);
      await secret.update({
        egress: { urls: [targetUrl] },
        material: secretMaterial,
      });
      await waitForSecretMaterial(secret);

      const response = await project.egress.fetch(
        new Request(targetUrl, {
          body: stringParam(
            input,
            "body",
            "the request asks for a placeholder, not raw secret material",
          ),
          headers: {
            authorization: `Bearer getSecret({ path: "${secretPath}" })`,
            "content-type": "text/plain",
            "x-itx-demo": "secret-egress",
          },
          method: "POST",
        }),
      );

      return {
        project: await project.describe(),
        response: await helpers.responseSummary(response),
        secret: await secret.describe(),
        targetUrl,
      };
    }

    case "blind-relay-proof-command":
      return {
        command: helpers.deployedBlindRelayCommand(),
        whyThisIsACommand:
          "The deployed Worker creates TLS ciphertext, but the relay side still needs a real TCP socket. This command downloads and runs a standalone Node relay against the deployed Worker.",
      };
  }
  throw new Error(`unknown playground action: ${action}`);
}

function playgroundHelpers(origin: string) {
  return {
    origin,
    targetUrl(path = "/playground/target") {
      return new URL(path, origin).toString();
    },
    projectSlug(prefix = "playground") {
      return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
    },
    async responseSummary(response: Response) {
      return responseSummary(response);
    },
    deployedBlindRelayCommand() {
      return [
        'tmp="$(mktemp -d)"',
        '&& cd "$tmp"',
        "&& npm init -y >/dev/null",
        `&& npm install ${ITX_EGRESS_CLI_DEPENDENCIES} >/dev/null`,
        `&& curl -fsS ${origin}/playground/itx-egress-cli.mts -o itx-egress-cli.mts`,
        `&& npx tsx itx-egress-cli.mts run --base-url ${origin} --demo-id default`,
      ].join(" ");
    },
  };
}

function itxEgressCliScript(): string {
  return String.raw`import net from "node:net";
import tls from "node:tls";
import { createHash } from "node:crypto";
import { os } from "@orpc/server";
import { createCli } from "trpc-cli";
import { z } from "zod";
import { RpcTarget, newWebSocketRpcSession } from "capnweb";
import WebSocket from "ws";

const DEFAULT_BASE_URL = "https://minimal-itx-v4-blind-relay-poc.iterate-dev-preview.workers.dev";
const BLIND_RELAY_PINNED_CERT_SHA256_HEADER = "x-itx-blind-relay-cert-sha256";
const TRUSTED_INTERNAL_ITX_TOKEN = "trusted-internal-itx-token";
const EGRESS_PROOF_HEADER = "x-itx-egress-proof";
const SECRET_MATERIAL = "blind-secret-material";
const HIDDEN_BODY = "payload hidden from relay";
const HIDDEN_PATH = "/playground/target";
const HIDDEN_QUERY = "worker-only";

class BlindRelayConnectionTarget extends RpcTarget {
  #observation;
  #readQueue = [];
  #readWaiters = [];
  #socket;
  #closed = false;
  #error;

  constructor({ observation, socket }) {
    super();
    this.#observation = observation;
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
      this.#observation.firstWorkerToTarget = chunk.slice(0, 96);
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
    for (const waiter of this.#readWaiters.splice(0)) {
      if (error === null) waiter.resolve(null);
      else waiter.reject(error);
    }
  }
}

class BlindRelayTarget extends RpcTarget {
  observations = [];
  #sockets = new Set();

  async dial({ host, port }) {
    const socket = net.connect({ host, port });
    this.#sockets.add(socket);
    socket.once("close", () => this.#sockets.delete(socket));

    const observation = {
      bytesTargetToWorker: 0,
      bytesWorkerToTarget: 0,
      firstTargetToWorker: new Uint8Array(),
      firstWorkerToTarget: new Uint8Array(),
      host,
      port,
      targetToWorkerChunks: [],
      workerToTargetChunks: [],
    };
    this.observations.push(observation);

    return new BlindRelayConnectionTarget({ observation, socket });
  }

  dispose() {
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
  }
}

async function runBlindRelay({
  assertTranscript,
  baseUrl: inputBaseUrl,
  body = HIDDEN_BODY,
  demoId = "default",
  secretMaterial = SECRET_MATERIAL,
}) {
  const baseUrl = normalizeBaseUrl(inputBaseUrl || process.env.ITX_BASE_URL || DEFAULT_BASE_URL);
  const relay = new BlindRelayTarget();
  const session = connectItx(baseUrl);
  let relayHandle;

  try {
    await postEvent(baseUrl, demoId, {
      phase: "waiting_for_node_relay",
      message: "Node process started and is connecting to the Worker ITX API.",
      detail: { baseUrl, demoId },
    });

    const root = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });
    const project = root.projects.create({
      slug: "blind-relay-demo-" + crypto.randomUUID().slice(0, 8),
    });
    const targetUrl = new URL("/playground/target", baseUrl);
    targetUrl.searchParams.set("demo", demoId);
    targetUrl.searchParams.set("token", HIDDEN_QUERY);
    const targetCertSha256 = await readLeafCertSha256(targetUrl);
    const secretPath = "/secrets/blind-relay-demo/" + crypto.randomUUID();
    const secret = project.secrets.get(secretPath);
    await secret.update({
      egress: { urls: [targetUrl.toString()] },
      material: secretMaterial,
    });
    await waitForCondition(async () => (await secret.describe()).hasMaterial, {
      description: "secret material to become available",
    });

    relayHandle = await project.egress.useBlindRelayForSecretEgress(relay);
    await postEvent(baseUrl, demoId, {
      phase: "relay_connected",
      message: "Node relay registered with project.egress.useBlindRelayForSecretEgress(...).",
      detail: { project: await project.describe(), targetCertSha256, targetUrl: targetUrl.toString() },
    });

    const response = await project.egress.fetch(
      new Request(targetUrl.toString(), {
        body,
        headers: {
          [BLIND_RELAY_PINNED_CERT_SHA256_HEADER]: targetCertSha256,
          [EGRESS_PROOF_HEADER]: 'Bearer getSecret({ path: "' + secretPath + '" })',
          "content-type": "text/plain",
        },
        method: "POST",
      }),
    );
    const responseBody = await response.json();
    if (response.status !== 200) {
      throw new Error("expected 200 from relayed egress, got " + response.status);
    }

    await postEvent(baseUrl, demoId, {
      phase: "secret_egress_relayed",
      message: "Worker substituted the secret, then sent HTTPS through the Node relay.",
      detail: responseBody,
    });

    const observation = relay.observations[0];
    if (observation === undefined) throw new Error("relay was not called");
    const transcript = concatenateBytes([
      ...observation.workerToTargetChunks,
      ...observation.targetToWorkerChunks,
    ]);
    const transcriptText = Buffer.from(transcript).toString("latin1");
    const hiddenStrings = [secretMaterial, body, HIDDEN_PATH, HIDDEN_QUERY];
    const leakedStrings = hiddenStrings.filter((hiddenString) => transcriptText.includes(hiddenString));
    if (assertTranscript && leakedStrings.length > 0) {
      throw new Error("relay transcript leaked plaintext: " + leakedStrings.join(", "));
    }

    await waitForCondition(async () => (await secret.describe()).audit.usedCount === 1, {
      description: "secret audit count to increment",
    });

    const proof = {
      bytesTargetToWorker: observation.bytesTargetToWorker,
      bytesWorkerToTarget: observation.bytesWorkerToTarget,
      firstTargetToWorkerByte: observation.firstTargetToWorker[0],
      firstWorkerToTargetByte: observation.firstWorkerToTarget[0],
      hiddenStringsCheckedAbsent: hiddenStrings,
      leakedStrings,
      relayDialed: observation.host + ":" + observation.port,
      targetClientIp: responseBody.clientIp,
    };
    await postEvent(baseUrl, demoId, {
      phase: "relay_saw_ciphertext_only",
      message: "Relay transcript contained TLS records and did not contain the secret, body, path, or query token.",
      detail: proof,
    });

    console.log(assertTranscript ? "Blind relay proof passed." : "Blind relay completed.");
    console.log("Worker: " + baseUrl);
    console.log("Demo status: " + new URL("/playground", baseUrl).toString());
    console.log("Target saw client IP: " + (responseBody.clientIp || "(not exposed by local dev)"));
    console.log("Target received auth: " + responseBody.headers[EGRESS_PROOF_HEADER]);
    console.log("Relay dialed: " + proof.relayDialed);
    console.log("Relay bytes worker->target: " + proof.bytesWorkerToTarget);
    console.log("Relay bytes target->worker: " + proof.bytesTargetToWorker);
    console.log("Plaintext checked absent from relay transcript: " + hiddenStrings.join(", "));
    return {
      mode: assertTranscript ? "blind-relay-proof" : "blind-relay",
      proof,
      targetReceivedAuth: responseBody.headers[EGRESS_PROOF_HEADER],
      targetResponse: responseBody,
    };
  } catch (error) {
    await postEvent(baseUrl, demoId, {
      phase: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    if (relayHandle !== undefined) await relayHandle.release().catch(() => {});
    relay.dispose();
    session[Symbol.dispose]?.();
  }
}

async function runPlainIntercept({
  baseUrl: inputBaseUrl,
  body = HIDDEN_BODY,
  demoId = "default",
  secretMaterial = SECRET_MATERIAL,
}) {
  const baseUrl = normalizeBaseUrl(inputBaseUrl || process.env.ITX_BASE_URL || DEFAULT_BASE_URL);
  const session = connectItx(baseUrl);
  let interceptHandle;

  try {
    await postEvent(baseUrl, demoId, {
      phase: "waiting_for_node_relay",
      message: "CLI started plain interceptor mode and is connecting to the Worker ITX API.",
      detail: { baseUrl, demoId },
    });

    const root = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });
    const project = root.projects.create({
      slug: "plain-intercept-demo-" + crypto.randomUUID().slice(0, 8),
    });
    const targetUrl = new URL("/playground/target", baseUrl);
    targetUrl.searchParams.set("demo", demoId);
    const secretPath = "/secrets/plain-intercept-demo/" + crypto.randomUUID();
    const secret = project.secrets.get(secretPath);
    await secret.update({
      egress: { urls: [targetUrl.toString()] },
      material: secretMaterial,
    });
    await waitForCondition(async () => (await secret.describe()).hasMaterial, {
      description: "secret material to become available",
    });

    interceptHandle = await project.egress.intercept(async (request) => {
      const intercepted = {
        body: await request.text(),
        headers: headersToObject(request.headers),
        note: "Plain intercept runs before secret substitution, so it sees plaintext body and getSecret(...) placeholders.",
        url: request.url,
      };
      await postEvent(baseUrl, demoId, {
        phase: "plain_intercept_saw_plaintext",
        message: "Plain interceptor saw the egress request before secret substitution.",
        detail: intercepted,
      });
      return Response.json(intercepted);
    });

    const response = await project.egress.fetch(
      new Request(targetUrl.toString(), {
        body,
        headers: {
          [EGRESS_PROOF_HEADER]: 'Bearer getSecret({ path: "' + secretPath + '" })',
          "content-type": "text/plain",
        },
        method: "POST",
      }),
    );
    const responseBody = await response.json();
    console.log("Plain intercept completed.");
    console.log("Worker: " + baseUrl);
    console.log("Interceptor saw body: " + responseBody.body);
    console.log("Interceptor saw auth: " + responseBody.headers[EGRESS_PROOF_HEADER]);
    return {
      intercepted: responseBody,
      mode: "plain-intercept",
      secret: await secret.describe(),
    };
  } catch (error) {
    await postEvent(baseUrl, demoId, {
      phase: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    if (interceptHandle !== undefined) await interceptHandle.release().catch(() => {});
    session[Symbol.dispose]?.();
  }
}

function connectItx(baseUrl) {
  const url = new URL("/api/itx", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url, { handshakeTimeout: 10_000 });
  return newWebSocketRpcSession(socket);
}

async function readLeafCertSha256(url) {
  if (url.protocol !== "https:") return "";
  const port = url.port === "" ? 443 : Number(url.port);
  return await new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host: url.hostname, port, servername: url.hostname, timeout: 10_000 },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert.raw) {
          reject(new Error("target did not expose a leaf certificate"));
          return;
        }
        resolve(createHash("sha256").update(cert.raw).digest("hex"));
      },
    );
    socket.once("error", reject);
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("timed out reading target leaf certificate"));
    });
  });
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

async function waitForCondition(predicate, opts) {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("timed out waiting for " + opts.description);
}

function concatenateBytes(chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
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

const router = os.router({
  run: os
    .input(
      z.object({
        baseUrl: z.string().default(DEFAULT_BASE_URL).describe("Deployed minimal-itx-v4 Worker base URL"),
        body: z.string().default(HIDDEN_BODY).describe("Request body to send through egress"),
        demoId: z.string().default("default").describe("Durable Object demo id shown on the playground page"),
        mode: z
          .enum(["plain-intercept", "blind-relay", "blind-relay-proof"])
          .describe("plain-intercept shows unencrypted request data; blind-relay sends encrypted TLS bytes through local Node; blind-relay-proof also asserts the relay transcript does not contain plaintext"),
        secretMaterial: z.string().default(SECRET_MATERIAL).describe("Secret material the Worker substitutes before egress"),
      }),
    )
    .handler(async ({ input }) => {
      if (input.mode === "plain-intercept") {
        return await runPlainIntercept(input);
      }
      return await runBlindRelay({
        ...input,
        assertTranscript: input.mode === "blind-relay-proof",
      });
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

function objectInput(input: unknown): Record<string, unknown> {
  return isRecord(input) ? input : {};
}

function stringParam(input: Record<string, unknown>, key: string, fallback: string): string {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function booleanParam(input: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = input[key];
  return typeof value === "boolean" ? value : fallback;
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
  return input === "waiting_for_node_relay" ||
    input === "plain_intercept_saw_plaintext" ||
    input === "relay_connected" ||
    input === "secret_egress_relayed" ||
    input === "target_received_request" ||
    input === "relay_saw_ciphertext_only" ||
    input === "failed"
    ? input
    : "idle";
}

async function waitForSecretMaterial(secret: Secret): Promise<void> {
  const deadline = Date.now() + 5_000;
  let lastDescription = await secret.describe();
  while (!lastDescription.hasMaterial) {
    if (Date.now() >= deadline) {
      throw new Error(
        `secret material did not become available before timeout: ${JSON.stringify(lastDescription)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    lastDescription = await secret.describe();
  }
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

function playgroundHtml(origin: string): string {
  const examples = JSON.stringify(playgroundExamples(origin));
  const blindRelayCommand = escapeHtml(playgroundHelpers(origin).deployedBlindRelayCommand());
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
    .presets {
      padding: 10px;
    }
    .preset {
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
    .preset.active {
      border-color: #1463ff;
      background: #eef4ff;
    }
    .preset span {
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
    <h1>Blind Relay POC Playground</h1>
    <p>Run ITX presets against this deployed Worker. Plain intercept sees <code>getSecret(...)</code> placeholders; blind relay receives only encrypted TLS bytes after the Worker substitutes the secret.</p>
    <div class="warning">Demo-only: anyone with this URL can create throwaway projects on this dev Worker. Do not enter real secrets.</div>
    <section class="panel demo-box">
      <h2>Run the interactive ITX egress CLI</h2>
      <p>This downloads a self-contained TypeScript CLI into a temp directory, installs pinned copies of <code>tsx</code>, <code>trpc-cli</code>, <code>@orpc/server</code>, <code>zod</code>, <code>capnweb</code>, and <code>ws</code>, then prompts you to choose plain intercept, blind relay, or blind relay proof mode. Requires Node.js 20+ and npm.</p>
      <ol>
        <li>You run Node locally.</li>
        <li>For plain intercept mode, the interceptor sees the unencrypted request before secret substitution.</li>
        <li>For blind relay modes, the Worker substitutes <code>getSecret(...)</code>, then Node opens the TCP connection, so the target sees your local relay IP while the relay only sees encrypted TLS bytes.</li>
      </ol>
      <div class="command-row">
        <button class="preset" id="copy-command" type="button">Copy command</button>
        <code class="command" id="relay-command">${blindRelayCommand}</code>
      </div>
      <p class="meta">Raw script: <a href="${blindRelayScriptUrl}">${blindRelayScriptUrl}</a></p>
    </section>
    <section class="panel demo-status">
      <h2>Live relay demo state</h2>
      <div class="status-row">
        <div>Demo state: <span class="phase" id="demo-phase">loading</span></div>
        <button class="preset" id="reset-demo" type="button">Reset log</button>
      </div>
      <div class="meta" id="demo-updated">Waiting for status...</div>
      <div class="proof-grid" id="demo-proof"></div>
      <div class="logs" id="demo-logs"></div>
    </section>
    <div class="layout">
      <aside class="panel presets" id="presets"></aside>
      <section class="panel editor">
        <div class="bar">
          <strong id="title">Snippet</strong>
          <span class="meta" id="origin">${escapeHtml(origin)}</span>
        </div>
        <textarea id="code" spellcheck="false"></textarea>
        <div class="bar">
          <span class="meta" id="status">Ready</span>
          <button class="run" id="run">Run</button>
        </div>
        <div class="summary" id="summary">Select a preset and run it to see the proof summary.</div>
        <pre id="output">{}</pre>
      </section>
    </div>
  </main>
  <script>
    const examples = ${examples};
    const presets = document.querySelector("#presets");
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
      for (const [buttonIndex, button] of [...presets.querySelectorAll("button")].entries()) {
        button.classList.toggle("active", buttonIndex === index);
      }
    }

    examples.forEach((example, index) => {
      const button = document.createElement("button");
      button.className = "preset";
      button.type = "button";
      button.textContent = example.title;
      const description = document.createElement("span");
      description.textContent = example.description;
      button.append(description);
      button.addEventListener("click", () => select(index));
      presets.append(button);
    });

    run.addEventListener("click", async () => {
      run.disabled = true;
      statusEl.textContent = "Running...";
      output.textContent = "";
      summary.textContent = "Running selected preset...";
      try {
        JSON.parse(code.value);
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
      switch (result.action || JSON.parse(code.value).action) {
        case "secret-egress": {
          const auth = result.response && result.response.body && result.response.body.headers && result.response.body.headers.authorization;
          const used = result.secret && result.secret.audit && result.secret.audit.usedCount;
          return "Target received materialized auth <code>" + escapeHtml(String(auth || "missing")) + "</code>; audit usedCount is <code>" + escapeHtml(String(used ?? "pending")) + "</code>.";
        }
        case "plain-intercept-placeholder": {
          const auth = result.response && result.response.body && result.response.body.headers && result.response.body.headers.authorization;
          const used = result.secret && result.secret.audit && result.secret.audit.usedCount;
          return "Interceptor saw placeholder auth <code>" + escapeHtml(String(auth || "missing")) + "</code>; audit usedCount is <code>" + escapeHtml(String(used ?? "pending")) + "</code>.";
        }
        case "blind-relay-proof-command":
          return "Run the command below in any terminal with Node.js 20+ and npm. It creates a temp directory, downloads the oRPC-backed CLI, and prompts for plain intercept, blind relay, or blind relay proof mode.";
        case "project-egress":
          return "Hosted target received a normal project egress request.";
        case "create-project":
          return "Created throwaway project <code>" + escapeHtml(String(result.projectId || result.name || "unknown")) + "</code>.";
        case "whoami":
          return "Authenticated as <code>" + escapeHtml(String(result.principal && result.principal.kind || "unknown")) + "</code>.";
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
        waiting_for_node_relay: "Waiting for local Node relay",
        plain_intercept_saw_plaintext: "Plain interceptor saw plaintext",
        relay_connected: "Node relay connected",
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
      id: "whoami",
      title: "Who Am I",
      description: "Shows the trusted-internal playground session.",
      code: `{
  "action": "whoami"
}`,
    },
    {
      id: "create-project",
      title: "Create Project",
      description: "Creates a disposable ITX project on this Worker.",
      code: `{
  "action": "create-project",
  "prefix": "demo"
}`,
    },
    {
      id: "project-egress",
      title: "Project Egress",
      description: "Sends a normal project egress request to the hosted target.",
      code: `{
  "action": "project-egress",
  "targetUrl": "${origin}/playground/target",
  "body": "hello from project egress"
}`,
    },
    {
      id: "secret-egress",
      title: "Secret Egress",
      description: "Shows the target receiving materialized secret auth.",
      code: `{
  "action": "secret-egress",
  "targetUrl": "${origin}/playground/target",
  "secretPath": "/secrets/playground/api-token",
  "secretMaterial": "demo-secret-material",
  "body": "the request asks for a placeholder, not raw secret material"
}`,
    },
    {
      id: "plain-intercept-placeholder",
      title: "Plain Intercept Placeholder",
      description: "Shows a normal interceptor only seeing getSecret(...).",
      code: `{
  "action": "plain-intercept-placeholder",
  "targetUrl": "${origin}/playground/target",
  "secretPath": "/secrets/playground/intercept-token",
  "secretMaterial": "intercept-demo-secret",
  "body": "plain interceptor should see this body"
}`,
    },
    {
      id: "blind-relay-proof-command",
      title: "Interactive Egress CLI Command",
      description:
        "Prints the standalone oRPC-backed CLI command for choosing plain or blind egress modes.",
      code: `{
  "action": "blind-relay-proof-command"
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
