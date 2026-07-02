import http from "node:http";
import https from "node:https";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
// oxlint-disable-next-line iterate/no-capnweb-http-batch -- this regression test intentionally proves the one-shot HTTP batch shape.
import { newHttpBatchRpcSession, RpcTarget } from "capnweb";
import { WebClient } from "@slack/web-api";
import { z } from "zod";
import { defineProcessorContract } from "./src/domains/streams/stream-processor.ts";
import { startEgressEcho, startMockMcp, startMockOpenApi } from "./itx-capability-fixtures.ts";
import { buildUrl, withItxSession } from "./test-helpers.ts";
import type { ItxWebSocketMessage } from "./test-helpers.ts";
import type { UnauthenticatedItx } from "./src/types.ts";
import { TRUSTED_INTERNAL_ITX_TOKEN } from "./src/auth.ts";
import {
  BLIND_RELAY_PINNED_CERT_SHA256_HEADER,
  completedHttpResponseLength,
  parseHttpResponse,
  fetchThroughTunnelingProxy,
} from "./src/domains/projects/blind-relay.ts";
import { RepoArtifactNameCodec } from "./src/domains/repos/utils.ts";
import type { TunnelingProxy, TunnelingProxyConnection, DynamicWorkerRef } from "./src/types.ts";
import {
  StreamProcessor,
  type StreamProcessorSnapshot,
} from "./src/domains/streams/stream-processor.ts";

const PROJECT_WORKER_FORWARDED_EVENT_TYPE = "events.iterate.test/project-worker-forwarded";
const AGENT_WEB_MESSAGE_SENT_TYPE = "events.iterate.com/agents/web-message-sent";
const AGENT_OUTPUT_ADDED_TYPE = "events.iterate.com/agent/output-added";
const EGRESS_PROOF_HEADER = "x-itx-egress-proof";

const ProjectWorkerForwardingProbeContract = defineProcessorContract({
  slug: "minimal-itx-v4.project-worker-forwarding-probe",
  version: "0.1.0",
  description: "Records project worker processEvent deliveries observed through an ITX stream.",
  stateSchema: z.object({
    childPaths: z.array(z.string()).default([]),
    markers: z.array(z.string()).default([]),
  }),
  events: {
    [PROJECT_WORKER_FORWARDED_EVENT_TYPE]: {
      payloadSchema: z.object({
        childPath: z.string(),
        marker: z.string(),
        originalType: z.string(),
      }),
    },
  },
  consumes: [PROJECT_WORKER_FORWARDED_EVENT_TYPE],
  emits: [],
});
type ProjectWorkerForwardingProbeContract = typeof ProjectWorkerForwardingProbeContract;
type ProjectWorkerForwardingProbeState = {
  childPaths: string[];
  markers: string[];
};

class ProjectWorkerForwardingProbeProcessor extends StreamProcessor<ProjectWorkerForwardingProbeContract> {
  readonly contract = ProjectWorkerForwardingProbeContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<ProjectWorkerForwardingProbeContract>["reduce"]>[0]) {
    return {
      childPaths: [...state.childPaths, event.payload.childPath],
      markers: [...state.markers, event.payload.marker],
    };
  }
}

function parseBody(body: string, contentType: string | string[] | undefined): Record<string, any> {
  if (typeof contentType === "string" && contentType.includes("application/json")) {
    try {
      return JSON.parse(body) as Record<string, any>;
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(body));
}

function echoedEgressProofHeader(body: unknown): string {
  const headers =
    ((body as { headers?: Record<string, string | string[]> }).headers as Record<
      string,
      string | string[]
    >) ?? {};
  const value = headers[EGRESS_PROOF_HEADER] ?? headers[EGRESS_PROOF_HEADER.toUpperCase()] ?? "";
  return Array.isArray(value) ? value.join(", ") : String(value);
}

function startMockSlack(): Promise<{
  calls: string[];
  close(): Promise<void>;
  url: string;
}> {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    const method = (req.url ?? "").replace(/^\//, "").split("?")[0] ?? "";
    calls.push(method);

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const payload = parseBody(body, req.headers["content-type"]);
      res.setHeader("content-type", "application/json");
      if (method === "chat.postMessage") {
        res.end(
          JSON.stringify({
            ok: true,
            channel: payload.channel,
            ts: "1718000000.000100",
            message: { text: payload.text, type: "message" },
            via: "mock-slack-api",
          }),
        );
        return;
      }
      if (method === "users.list") {
        res.end(
          JSON.stringify({
            ok: true,
            members: [
              { id: "U1", name: "ada" },
              { id: "U2", name: "grace" },
            ],
            via: "mock-slack-api",
          }),
        );
        return;
      }
      res.end(JSON.stringify({ ok: true, via: "mock-slack-api" }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        calls,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          }),
        url: `http://127.0.0.1:${port}/`,
      });
    });
  });
}

type BlindRelayObservation = {
  bytesTargetToWorker: number;
  bytesWorkerToTarget: number;
  firstTargetToWorker: Uint8Array;
  firstWorkerToTarget: Uint8Array;
  host: string;
  port: number;
  targetToWorkerChunks: Uint8Array[];
  workerToTargetChunks: Uint8Array[];
};

class BlindRelayConnectionTarget extends RpcTarget implements TunnelingProxyConnection {
  readonly #observation: BlindRelayObservation;
  readonly #readQueue: Uint8Array[] = [];
  readonly #readWaiters: Array<{
    reject(error: unknown): void;
    resolve(chunk: Uint8Array | null): void;
  }> = [];
  readonly #socket: net.Socket;
  #closed = false;
  #error: unknown;

  constructor({ observation, socket }: { observation: BlindRelayObservation; socket: net.Socket }) {
    super();
    this.#observation = observation;
    this.#socket = socket;

    socket.on("data", (chunk: Buffer) => {
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

  async read(): Promise<Uint8Array | null> {
    if (this.#readQueue.length > 0) return this.#readQueue.shift()!;
    if (this.#error !== undefined) throw this.#error;
    if (this.#closed) return null;
    return await new Promise<Uint8Array | null>((resolve, reject) => {
      this.#readWaiters.push({ reject, resolve });
    });
  }

  async write(chunk: Uint8Array): Promise<void> {
    this.#observation.bytesWorkerToTarget += chunk.byteLength;
    this.#observation.workerToTargetChunks.push(chunk.slice());
    if (this.#observation.firstWorkerToTarget.byteLength === 0) {
      this.#observation.firstWorkerToTarget = chunk.slice(0, 96);
    }
    await new Promise<void>((resolve, reject) => {
      this.#socket.write(chunk, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    this.#socket.destroy();
    this.#finishReads(null);
  }

  #finishReads(error: unknown) {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#readWaiters.splice(0)) {
      if (error === null) waiter.resolve(null);
      else waiter.reject(error);
    }
  }
}

class BlindRelayTarget extends RpcTarget implements TunnelingProxy, Disposable {
  readonly observations: BlindRelayObservation[] = [];
  readonly #sockets = new Set<net.Socket>();

  async dial({ host, port }: { host: string; port: number }): Promise<TunnelingProxyConnection> {
    const socket = net.connect({ host, port });
    this.#sockets.add(socket);
    socket.once("close", () => this.#sockets.delete(socket));

    const observation: BlindRelayObservation = {
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

  [Symbol.dispose](): void {
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
  }
}

function startBlindRelayHttpsTarget(): Promise<{
  certSha256: string;
  clientErrors: string[];
  close(): Promise<void>;
  requests: Array<{ body: string; proof: string | undefined; url: string | undefined }>;
  url: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), "itx-blind-relay-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ],
    { stdio: "ignore" },
  );

  const certSha256 = new X509Certificate(readFileSync(certPath)).fingerprint256
    .toLowerCase()
    .replaceAll(":", "");
  const requests: Array<{ body: string; proof: string | undefined; url: string | undefined }> = [];
  const clientErrors: string[] = [];
  const server = https.createServer(
    {
      cert: readFileSync(certPath),
      key: readFileSync(keyPath),
    },
    (req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const proof = req.headers[EGRESS_PROOF_HEADER];
        requests.push({
          body,
          proof: Array.isArray(proof) ? proof.join(", ") : proof,
          url: req.url,
        });
        res.setHeader("content-type", "application/json");
        res.setHeader("connection", "close");
        const payload = JSON.stringify({
          body,
          proof: Array.isArray(proof) ? proof.join(", ") : proof,
          url: req.url,
        });
        res.setHeader("content-length", String(Buffer.byteLength(payload)));
        res.end(payload);
      });
    },
  );
  server.on("clientError", (error, socket) => {
    clientErrors.push(error.message);
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        certSha256,
        clientErrors,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => {
              rmSync(dir, { force: true, recursive: true });
              error ? closeReject(error) : closeResolve();
            });
          }),
        requests,
        url: `https://localhost:${port}`,
      });
    });
  });
}

function asciiPreview(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}

function expectBlindRelayTranscriptToHidePlaintext(
  observation: BlindRelayObservation,
  hiddenStrings: string[],
) {
  const workerToTargetTranscript = concatenateBytes(observation.workerToTargetChunks);
  const targetToWorkerTranscript = concatenateBytes(observation.targetToWorkerChunks);
  expect(workerToTargetTranscript[0]).toBe(0x16);
  expect(targetToWorkerTranscript[0]).toBe(0x16);
  const relayText = `${asciiPreview(workerToTargetTranscript)}\n${asciiPreview(targetToWorkerTranscript)}`;
  for (const hiddenString of hiddenStrings) {
    expect(relayText).not.toContain(hiddenString);
  }
}

function concatenateBytes(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function httpBytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

class PathFunctionTarget extends RpcTarget {
  constructor(readonly target: unknown) {
    super();
  }

  invokeCapability({ args, path }: { args: unknown[]; path: string[] }) {
    if (path.length === 0) return this.target;

    let receiver = this.target;
    for (const segment of path.slice(0, -1)) {
      if (receiver === null || (typeof receiver !== "object" && typeof receiver !== "function")) {
        throw new Error(`path "${path.join(".")}" hit ${String(receiver)}`);
      }
      receiver = Reflect.get(receiver, segment);
    }

    const method = path.at(-1)!;
    if (receiver === null || (typeof receiver !== "object" && typeof receiver !== "function")) {
      throw new Error(`path "${path.join(".")}" hit ${String(receiver)}`);
    }
    const handler = Reflect.get(receiver, method);
    if (typeof handler !== "function") {
      throw new Error(`path "${path.join(".")}" did not resolve to a function`);
    }
    return Reflect.apply(handler, receiver, args);
  }
}

function fencedAgentScript(code: string): string {
  return ["The faux LLM produced this codemode block.", "```js", code.trim(), "```"].join("\n");
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  opts: { description: string; intervalMs?: number; timeoutMs?: number },
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const intervalMs = opts.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${opts.description}`);
}

// These are hand written tests - they MUST pass
describe("minimal itx v4", () => {
  test("Blind relay HTTP parser handles complete response framing", async () => {
    const fixed = httpBytes("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhelloextra");
    const fixedLength = completedHttpResponseLength(fixed);
    expect(fixedLength).toBe(fixed.byteLength - "extra".length);
    await expect(parseHttpResponse(fixed.slice(0, fixedLength)).text()).resolves.toBe("hello");

    const chunked = httpBytes(
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\nextra",
    );
    const chunkedLength = completedHttpResponseLength(chunked);
    expect(chunkedLength).toBe(chunked.byteLength - "extra".length);
    await expect(parseHttpResponse(chunked.slice(0, chunkedLength)).text()).resolves.toBe("hello");

    const chunkedWithTrailers = httpBytes(
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\nx-demo: trailer\r\n\r\n",
    );
    expect(completedHttpResponseLength(chunkedWithTrailers)).toBe(chunkedWithTrailers.byteLength);
    await expect(parseHttpResponse(chunkedWithTrailers).text()).resolves.toBe("hello");

    const conflictingFraming = httpBytes(
      "HTTP/1.1 200 OK\r\nContent-Length: 999\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\nextra",
    );
    const conflictingLength = completedHttpResponseLength(conflictingFraming);
    expect(conflictingLength).toBe(conflictingFraming.byteLength - "extra".length);
    await expect(
      parseHttpResponse(conflictingFraming.slice(0, conflictingLength)).text(),
    ).resolves.toBe("hello");
  });

  test("Blind relay HTTP parser distinguishes incomplete and malformed framing", () => {
    expect(
      completedHttpResponseLength(httpBytes("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhe")),
    ).toBeUndefined();
    expect(
      completedHttpResponseLength(
        httpBytes("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhe"),
      ),
    ).toBeUndefined();
    expect(() =>
      completedHttpResponseLength(
        httpBytes("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nz\r\nhello\r\n"),
      ),
    ).toThrow("invalid chunk size");
    expect(() =>
      completedHttpResponseLength(
        httpBytes("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhelloX\n"),
      ),
    ).toThrow("chunk missing CRLF");
  });

  test("Unauthenticated itx can't do anything", async () => {
    using session = withItxSession();
    await expect((<any>session).projects).rejects.toThrow();
  });

  test("Authenticated itx whoami returns principal", async () => {
    using session = withItxSession();
    using itx = session.authenticate({
      type: "token",
      token: {
        principal: "alice",
        projectScopes: ["prj_alice", "prj_ref"],
        type: "user",
      },
    });

    const projects = itx.projects;

    expect(await itx.whoami()).toBe("alice");
    expect(await projects.list()).toEqual(["prj_alice", "prj_ref"]);
  });

  test("Authenticated internal auth itx can create project and append to stream", async () => {
    const messages: ItxWebSocketMessage[] = [];
    using session = withItxSession({
      onWebSocketMessage: (message) => {
        messages.push(message);
      },
    });
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });

    // TODO project slug should be derived from tests etc as in apps/os
    using project = itx.projects.create({ slug: "alice-project" });
    const description = await project.describe();
    expect(description.projectId).toMatch(/prj_[0-9a-f-]+$/);
    expect(description.name).toMatch(/prj_[0-9a-f-]+\.iterate\/$/);
    expect(messages).toContainEqual([
      expect.any(Number),
      "out",
      ["push", ["pipeline", 1, ["projects", "create"], [{ slug: "alice-project" }]]],
    ]);

    using stream = project.streams.get("/");

    const events = await stream.getEvents();

    // We don't care about ordering, just that the stream contains each of these
    // event types. Mapping to types + arrayContaining is the concise idiomatic way.
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "events.iterate.com/stream/created",
        "events.iterate.com/stream/woken",
        "events.iterate.com/stream/subscription-configured",
        "events.iterate.com/project/create-requested",
        "events.iterate.com/repo/create-requested",
        "events.iterate.com/repo/created",
        "events.iterate.com/project/created",
        "events.iterate.com/stream/subscriber-disconnected",
      ]),
    );

    const repoCreated = events.find((event) => event.type === "events.iterate.com/repo/created");
    const projectCreated = events.find(
      (event) => event.type === "events.iterate.com/project/created",
    );
    expect(repoCreated).toMatchObject({
      payload: {
        artifactName: RepoArtifactNameCodec.stringify({
          path: "/",
          projectId: description.projectId,
        }),
        path: "/",
        projectId: description.projectId,
      },
    });
    expect(projectCreated).toBeTruthy();
    expect(repoCreated!.offset).toBeLessThan(projectCreated!.offset);

    expect(await project.repo.whoami()).toBe(`repo ${description.projectId}:/`);
    expect(await project.repos.get("/").whoami()).toBe(`repo ${description.projectId}:/`);

    const workerResponse = await project.worker.fetch(new Request("https://example.com/probe"));
    expect(await workerResponse.text()).toBe("project worker fetched /probe");

    const [committedEvent] = await project.streams.get("/some/path").append({
      type: "hello-world",
    });
    expect(committedEvent).toMatchObject({
      type: "hello-world",
      offset: 3, // first two events are created and woken
    });
    expect(await project.streams.get("/some/path").getEvents()).toMatchObject([
      {
        type: "events.iterate.com/stream/created",
      },
      {
        type: "events.iterate.com/stream/woken",
      },
      committedEvent,
    ]);

    const getSecret = async () => "bananas";

    using provision = await project.provideCapability({
      path: ["someMethodInTestRunner"],
      type: "live",
      capability: {
        getSecret: (secretGetter: () => Promise<string>) => secretGetter(),
      },
    });

    // @ts-expect-error - TODO maybe some niceties
    expect(await project.someMethodInTestRunner.getSecret(getSecret)).toBe("bananas");

    // make new itx connection

    using newSession = withItxSession();
    using newItx = newSession.authenticate({
      type: "token",
      token: {
        projectScopes: [description.projectId],
        type: "user",
        principal: "alice",
      },
    });

    using newConnectionProject = newItx.projects.get(description.projectId);
    expect(
      // @ts-expect-error - TODO maybe some niceties
      await newConnectionProject.someMethodInTestRunner.getSecret(getSecret),
    ).toBe("bananas");

    await provision.revoke();

    // @ts-expect-error
    await expect(project.someMethodInTestRunner.getSecret(getSecret)).rejects.toThrow(
      /no capability "someMethodInTestRunner.getSecret"/,
    );
    await expect(
      // @ts-expect-error - TODO maybe some niceties
      newConnectionProject.someMethodInTestRunner.getSecret(getSecret),
    ).rejects.toThrow(/no capability "someMethodInTestRunner.getSecret"/);
  });

  test("Project describe exposes Workers AI as a builtin capability", async () => {
    using session = withItxSession();
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });

    using project = itx.projects.create({ slug: "ai-builtin" });
    const description = await project.describe();

    expect(description.capabilities).toContainEqual({ path: ["ai"], type: "builtin" });
  });

  test("Trusted internal root can access global streams and repos", async () => {
    using session = withItxSession();
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });

    const path = `/global-${crypto.randomUUID()}`;
    const [streamEvent] = await itx.streams.get(path).append({
      type: "events.iterate.test/global-stream",
      payload: { path },
    });
    expect(streamEvent).toMatchObject({
      offset: 3,
      payload: { path },
      type: "events.iterate.test/global-stream",
    });

    using repo = await itx.repos.create({ path });
    expect(await repo.whoami()).toBe(`repo null:${path}`);
  });

  test("Project egress substitutes path-addressed secrets for explicit and project worker fetches", async () => {
    const echo = await startEgressEcho();
    using session = withItxSession();
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });

    try {
      using project = itx.projects.create({ slug: `project-egress-${crypto.randomUUID()}` });
      const secretPath = `/secrets/egress-proof/${crypto.randomUUID()}`;
      using secret = project.secrets.get(secretPath);
      await secret.update({
        egress: { urls: [echo.url] },
        material: "actual-secret-material",
      });

      const agentPath = `/agents/list-proof/${crypto.randomUUID()}`;
      const repoPath = `/repos/list-proof/${crypto.randomUUID()}`;
      await project.streams.get(agentPath).append({
        type: "events.iterate.test/list-agent",
      });
      await project.streams.get(repoPath).append({
        type: "events.iterate.test/list-repo",
      });
      await waitForCondition(
        async () => (await project.secrets.list()).some((item) => item.path === secretPath),
        { description: "secret stream to appear in project processor list" },
      );
      await waitForCondition(async () => (await secret.describe()).hasMaterial, {
        description: "secret processor to fold the update",
      });

      const described = await secret.describe();
      expect(described).toMatchObject({
        audit: { usedCount: 0 },
        egress: { urls: [echo.url] },
        hasMaterial: true,
      });
      expect(JSON.stringify(described)).not.toContain("actual-secret-material");

      const secretReference = `Bearer getSecret({ path: "${secretPath}" })`;
      const expected = "Bearer actual-secret-material";

      const explicitResponse = await project.egress.fetch(
        new Request(echo.url, {
          headers: { [EGRESS_PROOF_HEADER]: secretReference },
        }),
      );
      expect(explicitResponse.status).toBe(200);
      expect(echoedEgressProofHeader(await explicitResponse.json())).toBe(expected);

      const workerBody = await project.worker.testFetch({
        headerValue: secretReference,
        url: echo.url,
      });
      expect(echoedEgressProofHeader(workerBody)).toBe(expected);

      await waitForCondition(async () => (await secret.describe()).audit.usedCount === 2, {
        description: "secret usage audit to fold",
      });
      expect(await project.streams.list()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "/" }),
          expect.objectContaining({ path: secretPath }),
        ]),
      );
      const projectState = (await project.processor.snapshot()).state;
      expect(projectState.streams).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "/" }),
          expect.objectContaining({ path: agentPath }),
          expect.objectContaining({ path: repoPath }),
          expect.objectContaining({ path: secretPath }),
        ]),
      );
      expect(projectState.agents).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: agentPath })]),
      );
      expect(projectState.repos).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "/" }),
          expect.objectContaining({ path: repoPath }),
        ]),
      );
      expect(projectState.secrets).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: secretPath })]),
      );
      expect(await project.secrets.list()).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: secretPath })]),
      );
      expect((await project.agents.list()).some((item) => item.path.startsWith("/agents/"))).toBe(
        true,
      );
      expect((await project.repos.list()).some((item) => item.path === "/")).toBe(true);
      expect((await project.repos.list()).some((item) => item.path.startsWith("/repos/"))).toBe(
        true,
      );
      expect((await project.agents.get(agentPath).processor.snapshot()).state.history).toEqual([]);
      expect((await project.repo.processor.snapshot()).state.created).toBe(true);
      expect((await secret.processor.snapshot()).state.egress).toEqual({ urls: [echo.url] });
    } finally {
      await echo.close();
    }
  });

  test("Project egress intercept catches explicit and worker fetches before secret substitution", async () => {
    const echo = await startEgressEcho();
    using session = withItxSession();
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });

    try {
      using project = itx.projects.create({
        slug: `project-egress-intercept-${crypto.randomUUID()}`,
      });
      const secretPath = `/secrets/egress-intercept/${crypto.randomUUID()}`;
      using secret = project.secrets.get(secretPath);
      await secret.update({
        egress: { urls: [echo.url] },
        material: "intercept-secret-material",
      });
      await waitForCondition(async () => (await secret.describe()).hasMaterial, {
        description: "intercept proof secret to be available",
      });

      const secretReference = `Bearer getSecret({ path: "${secretPath}" })`;
      using intercept = await project.egress.intercept(async (request) => {
        return Response.json({
          intercepted: true,
          proof: request.headers.get(EGRESS_PROOF_HEADER),
          url: request.url,
        });
      });

      const explicitResponse = await project.egress.fetch(
        new Request(echo.url, {
          headers: { [EGRESS_PROOF_HEADER]: secretReference },
        }),
      );
      await expect(explicitResponse.json()).resolves.toEqual({
        intercepted: true,
        proof: secretReference,
        url: echo.url,
      });

      const workerBody = await project.worker.testFetch({
        headerValue: secretReference,
        url: echo.url,
      });
      expect(workerBody).toEqual({
        intercepted: true,
        proof: secretReference,
        url: echo.url,
      });
      expect(JSON.stringify(workerBody)).not.toContain("intercept-secret-material");
      expect((await secret.describe()).audit.usedCount).toBe(0);

      await intercept.release();

      const terminalResponse = await project.egress.fetch(
        new Request(echo.url, {
          headers: { [EGRESS_PROOF_HEADER]: secretReference },
        }),
      );
      expect(echoedEgressProofHeader(await terminalResponse.json())).toBe(
        "Bearer intercept-secret-material",
      );
    } finally {
      await echo.close();
    }
  });

  test("Blind relayed fetch encrypts plaintext before it reaches a Node relay", async () => {
    const target = await startBlindRelayHttpsTarget();
    using relay = new BlindRelayTarget();

    try {
      const response = await fetchThroughTunnelingProxy(
        new Request(`${target.url}/secret-path?token=worker-only`, {
          body: "payload hidden from relay",
          headers: {
            [BLIND_RELAY_PINNED_CERT_SHA256_HEADER]: target.certSha256,
            [EGRESS_PROOF_HEADER]: "Bearer blind-secret-material",
          },
          method: "POST",
        }),
        relay,
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        body: "payload hidden from relay",
        proof: "Bearer blind-secret-material",
        url: "/secret-path?token=worker-only",
      });
      expect(target.requests).toEqual([
        {
          body: "payload hidden from relay",
          proof: "Bearer blind-secret-material",
          url: "/secret-path?token=worker-only",
        },
      ]);

      const [observation] = relay.observations;
      expect(observation).toMatchObject({
        host: "localhost",
        port: Number(new URL(target.url).port),
      });
      expectBlindRelayTranscriptToHidePlaintext(observation!, [
        "blind-secret-material",
        "payload hidden from relay",
        "/secret-path",
        "worker-only",
      ]);
    } finally {
      await target.close();
    }
  });

  test("Project egress relays secret-backed HTTPS without exposing plaintext to the interceptor", async () => {
    const target = await startBlindRelayHttpsTarget();
    using relay = new BlindRelayTarget();
    using session = withItxSession();
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });

    try {
      using project = itx.projects.create({
        slug: `project-blind-egress-${crypto.randomUUID()}`,
      });
      const secretPath = `/secrets/blind-egress/${crypto.randomUUID()}`;
      using secret = project.secrets.get(secretPath);
      await secret.update({
        egress: { urls: [target.url] },
        material: "blind-secret-material",
      });
      await waitForCondition(async () => (await secret.describe()).hasMaterial, {
        description: "blind egress proof secret to be available",
      });

      using intercept = await project.egress.useEgressHttpsProxy(relay);
      const request = new Request(`${target.url}/secret-path?token=worker-only`, {
        body: "payload hidden from relay",
        headers: {
          [BLIND_RELAY_PINNED_CERT_SHA256_HEADER]: target.certSha256,
          [EGRESS_PROOF_HEADER]: `Bearer getSecret({ path: "${secretPath}" })`,
        },
        method: "POST",
      });
      let response: Response;
      try {
        response = await project.egress.fetch(request);
      } catch (error) {
        throw new Error(
          `blind relayed egress threw ${error instanceof Error ? error.message : String(error)} observations=${JSON.stringify(
            relay.observations.map((observation) => ({
              bytesTargetToWorker: observation.bytesTargetToWorker,
              bytesWorkerToTarget: observation.bytesWorkerToTarget,
              firstTargetToWorker: asciiPreview(observation.firstTargetToWorker),
              firstWorkerToTarget: asciiPreview(observation.firstWorkerToTarget),
              host: observation.host,
              port: observation.port,
            })),
          )} targetRequests=${JSON.stringify(target.requests)} clientErrors=${JSON.stringify(target.clientErrors)}`,
        );
      }
      if (response.status !== 200) {
        throw new Error(
          `expected blind relayed egress status 200, got ${response.status}: ${await response.text()} clientErrors=${JSON.stringify(target.clientErrors)}`,
        );
      }
      await expect(response.json()).resolves.toEqual({
        body: "payload hidden from relay",
        proof: "Bearer blind-secret-material",
        url: "/secret-path?token=worker-only",
      });
      expect(target.requests).toEqual([
        {
          body: "payload hidden from relay",
          proof: "Bearer blind-secret-material",
          url: "/secret-path?token=worker-only",
        },
      ]);

      const [observation] = relay.observations;
      expect(observation).toMatchObject({
        host: "localhost",
        port: Number(new URL(target.url).port),
      });
      expectBlindRelayTranscriptToHidePlaintext(observation!, [
        "blind-secret-material",
        "payload hidden from relay",
        "/secret-path",
        "worker-only",
      ]);

      await waitForCondition(async () => (await secret.describe()).audit.usedCount === 1, {
        description: "blind egress secret usage audit to fold",
      });

      await intercept.release();
    } finally {
      await target.close();
    }
  });

  test("OpenAPI built-in connects directly and mounts as a described capability", async () => {
    const secretMaterial = "openapi-secret";
    const api = await startMockOpenApi({ expectedAuthorization: `Bearer ${secretMaterial}` });
    using session = withItxSession();
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });

    try {
      using project = itx.projects.create({ slug: `openapi-${crypto.randomUUID()}` });
      const secretPath = `/secrets/openapi/${crypto.randomUUID()}`;
      using secret = project.secrets.get(secretPath);
      await secret.update({
        egress: { urls: [api.url] },
        material: secretMaterial,
      });
      await waitForCondition(async () => (await secret.describe()).hasMaterial, {
        description: "OpenAPI secret to be available",
      });

      const headers = { authorization: `Bearer getSecret({ path: "${secretPath}" })` };
      const specUrl = `${api.url}/openapi.json`;

      // Cap'n Web promise pipelining lets dynamic operation members be called
      // before connect() resolves.
      const directPromise = project.openapi.connect({ headers, specUrl });
      await expect(
        // @ts-expect-error - OpenAPI operations are derived at runtime.
        directPromise.findPetsByStatus({ status: "pipelined" }),
      ).resolves.toEqual([{ id: 1, name: "pipelined-pet", status: "pipelined" }]);
      const direct = await directPromise;
      await expect(
        // @ts-expect-error - OpenAPI operations are derived at runtime.
        direct.findPetsByStatus({ status: "available" }),
      ).resolves.toEqual([{ id: 1, name: "available-pet", status: "available" }]);
      await expect(
        // @ts-expect-error - OpenAPI operations are derived at runtime.
        (await project.openapi.connect({ headers, specUrl })).findPetsByStatus({
          status: "sold",
        }),
      ).resolves.toEqual([{ id: 1, name: "sold-pet", status: "sold" }]);

      const instructions = "Tiny Pets: call operationIds directly through the mounted capability.";
      const types =
        "export type Capability = { findPetsByStatus(input: { status: string }): Promise<unknown> };";
      // Metadata belongs to the capability-provided event. The connect target is
      // only the callable capability value.
      using _provision = await project.provideCapability({
        expression: ["openapi", ["connect", { headers, specUrl }]],
        instructions,
        path: ["pets"],
        type: "itx-expression",
        types,
      });
      const described = await project.describe();
      expect(described.capabilities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            instructions,
            path: ["pets"],
            type: "itx-expression",
            types,
          }),
        ]),
      );
      await expect(
        // @ts-expect-error - mounted OpenAPI capability root.
        project.pets.findPetsByStatus({ status: "pending" }),
      ).resolves.toEqual([{ id: 1, name: "pending-pet", status: "pending" }]);

      if (api.authHeaders.length > 0) {
        expect(api.authHeaders).toEqual(expect.arrayContaining([`Bearer ${secretMaterial}`]));
      }
    } finally {
      await api.close();
    }
  });

  test("MCP built-in connects directly and mounts as a described capability", async () => {
    const secretMaterial = "mcp-secret";
    const mcp = await startMockMcp({ expectedAuthorization: `Bearer ${secretMaterial}` });
    using session = withItxSession();
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });

    try {
      using project = itx.projects.create({ slug: `mcp-${crypto.randomUUID()}` });
      const secretPath = `/secrets/mcp/${crypto.randomUUID()}`;
      using secret = project.secrets.get(secretPath);
      await secret.update({
        egress: { urls: [mcp.url] },
        material: secretMaterial,
      });
      await waitForCondition(async () => (await secret.describe()).hasMaterial, {
        description: "MCP secret to be available",
      });

      const headers = { authorization: `Bearer getSecret({ path: "${secretPath}" })` };

      // Cap'n Web promise pipelining lets dynamic tool members be called before
      // connect() resolves.
      const directPromise = project.mcp.connect({ headers, url: mcp.url });
      await expect(
        // @ts-expect-error - MCP tools are derived at runtime.
        directPromise.search_docs({ query: "Pipelined" }),
      ).resolves.toEqual({ answer: "docs:Pipelined" });
      const direct = await directPromise;
      await expect(
        // @ts-expect-error - MCP tools are derived at runtime.
        direct.search_docs({ query: "Workers" }),
      ).resolves.toEqual({ answer: "docs:Workers" });
      await expect(
        // @ts-expect-error - MCP tools are derived at runtime.
        (await project.mcp.connect({ headers, url: mcp.url })).search_docs({
          query: "Pipelines",
        }),
      ).resolves.toEqual({ answer: "docs:Pipelines" });

      const instructions = "Call search_docs on the mounted MCP docs capability.";
      const types =
        "export type Capability = { search_docs(input: { query: string }): Promise<unknown> };";
      using _provision = await project.provideCapability({
        expression: ["mcp", ["connect", { headers, url: mcp.url }]],
        instructions,
        path: ["docs"],
        type: "itx-expression",
        types,
      });
      const described = await project.describe();
      expect(described.capabilities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            instructions,
            path: ["docs"],
            type: "itx-expression",
            types,
          }),
        ]),
      );
      await expect(
        // @ts-expect-error - mounted MCP capability root.
        project.docs.search_docs({ query: "Durable Objects" }),
      ).resolves.toEqual({ answer: "docs:Durable Objects" });

      if (mcp.methods.length > 0) {
        expect(mcp.methods).toEqual(expect.arrayContaining(["initialize", "tools/call"]));
        expect(mcp.methods).not.toContain("tools/list");
      }
      if (mcp.authHeaders.length > 0) {
        expect(mcp.authHeaders).toEqual(expect.arrayContaining([`Bearer ${secretMaterial}`]));
      }
    } finally {
      await mcp.close();
    }
  });

  test("ITX expression capabilities mount MCP and OpenAPI built-ins through connect()", async () => {
    const secretMaterial = "expr-secret";
    const api = await startMockOpenApi({ expectedAuthorization: `Bearer ${secretMaterial}` });
    const mcp = await startMockMcp({ expectedAuthorization: `Bearer ${secretMaterial}` });
    using session = withItxSession();
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });

    try {
      using project = itx.projects.create({ slug: `expr-builtins-${crypto.randomUUID()}` });
      const secretPath = `/secrets/expr-builtins/${crypto.randomUUID()}`;
      using secret = project.secrets.get(secretPath);
      await secret.update({
        egress: { urls: [api.url, mcp.url] },
        material: secretMaterial,
      });
      await waitForCondition(async () => (await secret.describe()).hasMaterial, {
        description: "expression built-in secret to be available",
      });

      const headers = { authorization: `Bearer getSecret({ path: "${secretPath}" })` };
      const petsInstructions = "Tiny Pets expression mount: call findPetsByStatus with a status.";
      const petsTypes =
        "export type Capability = { findPetsByStatus(input: { status: string }): Promise<unknown> };";
      const docsInstructions = "Docs expression mount: call search_docs with a query.";
      const docsTypes =
        "export type Capability = { search_docs(input: { query: string }): Promise<unknown> };";
      using _petsProvision = await project.provideCapability({
        expression: [
          "openapi",
          [
            "connect",
            {
              headers,
              specUrl: `${api.url}/openapi.json`,
            },
          ],
        ],
        instructions: petsInstructions,
        path: ["exprPets"],
        type: "itx-expression",
        types: petsTypes,
      });
      using _docsProvision = await project.provideCapability({
        expression: ["mcp", ["connect", { headers, url: mcp.url }]],
        instructions: docsInstructions,
        path: ["exprDocs"],
        type: "itx-expression",
        types: docsTypes,
      });

      const described = await project.describe();
      expect(described.capabilities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            instructions: petsInstructions,
            path: ["exprPets"],
            type: "itx-expression",
            types: petsTypes,
          }),
          expect.objectContaining({
            instructions: docsInstructions,
            path: ["exprDocs"],
            type: "itx-expression",
            types: docsTypes,
          }),
        ]),
      );

      await expect(
        // @ts-expect-error - mounted expression capability root.
        project.exprPets.findPetsByStatus({ status: "available" }),
      ).resolves.toEqual([{ id: 1, name: "available-pet", status: "available" }]);
      await expect(
        // @ts-expect-error - mounted expression capability root.
        project.exprDocs.search_docs({ query: "Expressions" }),
      ).resolves.toEqual({ answer: "docs:Expressions" });
    } finally {
      await api.close();
      await mcp.close();
    }
  });

  test("ITX expression capabilities mount project workers, streams, method aliases, and functions", async () => {
    const marker = crypto.randomUUID();
    using session = withItxSession();
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });
    using project = itx.projects.create({ slug: `expr-project-${crypto.randomUUID()}` });

    const workerRef = {
      entrypoint: "Worker",
      path: "/",
      source: {
        mainModule: "worker.js",
        modules: {
          "worker.js": `
            import { WorkerEntrypoint } from "cloudflare:workers";

            export class Worker extends WorkerEntrypoint {
              echo(input) {
                return { input, via: "expression-worker" };
              }

              addFunction() {
                return (left, right) => left + right;
              }

              invokeCapability({ args, path }) {
                return { args, path, via: "flattened-expression-worker" };
              }
            }
          `,
        },
        type: "inline",
      },
      type: "stateless",
    } satisfies DynamicWorkerRef;

    using _workerProvision = await project.provideCapability({
      expression: ["workers", ["get", workerRef]],
      instructions: "Echoes through a worker expression.",
      path: ["exprWorker"],
      type: "itx-expression",
      types: "export type Capability = { echo(input: unknown): Promise<unknown> };",
    });
    await expect(
      // @ts-expect-error - mounted expression capability root.
      project.exprWorker.echo({ ok: true }),
    ).resolves.toEqual({ input: { ok: true }, via: "expression-worker" });

    using _flatWorkerProvision = await project.provideCapability({
      expression: ["workers", ["get", workerRef]],
      flattenNestedPaths: true,
      path: ["exprFlatWorker"],
      type: "itx-expression",
    });
    await expect(
      // @ts-expect-error - mounted expression worker with flattened dispatch.
      project.exprFlatWorker.tools.echo("hello"),
    ).resolves.toEqual({
      args: ["hello"],
      path: ["tools", "echo"],
      via: "flattened-expression-worker",
    });

    using _functionProvision = await project.provideCapability({
      expression: ["workers", ["get", workerRef], ["addFunction"]],
      path: ["exprAdd"],
      type: "itx-expression",
    });
    await expect(
      // @ts-expect-error - mounted expression function root.
      project.exprAdd(20, 22),
    ).resolves.toBe(42);

    using _streamProvision = await project.provideCapability({
      expression: ["streams", ["get", "/expr/special/stream"]],
      path: ["mySpecialStream"],
      type: "itx-expression",
    });
    // @ts-expect-error - mounted expression stream root.
    const [event] = await project.mySpecialStream.append({
      payload: { ok: true },
      type: "events.iterate.test/itx-expression-stream",
    });
    expect(event.payload).toEqual({ ok: true });

    using _sourceProvision = await project.provideCapability({
      capability: {
        deeper: {
          path: {
            someMethod(input: string) {
              return `aliased:${input}`;
            },
          },
        },
      },
      path: ["exprSource"],
      type: "live",
    });
    using _aliasProvision = await project.provideCapability({
      expression: ["exprSource", "deeper", "path", "someMethod"],
      path: ["exprSomeMethod"],
      type: "itx-expression",
    });
    await expect(
      // @ts-expect-error - mounted expression method root.
      project.exprSomeMethod("ok"),
    ).resolves.toBe("aliased:ok");

    using _factoryProvision = await project.provideCapability({
      capability: {
        makeDomainObject() {
          return {
            capability: {
              echo(input: string) {
                return `domain:${input}`;
              },
            },
            instructions: "literal data, not capability metadata",
            status() {
              return `status:${marker}`;
            },
            types: "literal data, not capability metadata",
          };
        },
      },
      path: ["exprFactory"],
      type: "live",
    });
    using _domainObjectProvision = await project.provideCapability({
      expression: ["exprFactory", ["makeDomainObject"]],
      path: ["exprDomainObject"],
      type: "itx-expression",
    });

    await expect(
      // @ts-expect-error - mounted expression object root.
      project.exprDomainObject.status(),
    ).resolves.toBe(`status:${marker}`);
    await expect(
      // @ts-expect-error - mounted expression object root.
      project.exprDomainObject.capability.echo("ok"),
    ).resolves.toBe("domain:ok");

    const description = await project.describe();
    const domainObjectDescription = description.capabilities.find((capability) =>
      capability.path.every((segment, index) => segment === ["exprDomainObject"][index]),
    );
    expect(domainObjectDescription).toMatchObject({
      path: ["exprDomainObject"],
      type: "itx-expression",
    });
    expect(domainObjectDescription?.instructions).toBeUndefined();
    expect(domainObjectDescription?.types).toBeUndefined();
  });

  test("ITX expression capabilities resolve aliases against the current ITX host path", async () => {
    using session = withItxSession();
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });
    using project = itx.projects.create({ slug: `expr-agent-${crypto.randomUUID()}` });
    const agentPath = `/agents/expr-agent-${crypto.randomUUID()}`;
    using agent = project.agents.get(agentPath);

    using _sourceProvision = await agent.provideCapability({
      capability: {
        deeper: {
          path: {
            someMethod(input: string) {
              return `agent-aliased:${input}`;
            },
          },
        },
      },
      path: ["exprSource"],
      type: "live",
    });
    using _aliasProvision = await agent.provideCapability({
      expression: ["exprSource", "deeper", "path", "someMethod"],
      path: ["exprAgentSomeMethod"],
      type: "itx-expression",
    });

    await expect(
      // @ts-expect-error - mounted agent expression method root.
      agent.exprAgentSomeMethod("ok"),
    ).resolves.toBe("agent-aliased:ok");
    await expect(
      // @ts-expect-error - proves the alias was mounted on the agent host, not project root.
      project.exprAgentSomeMethod("project should not see this"),
    ).rejects.toThrow(/no capability "exprAgentSomeMethod"/);
  });

  test("ITX expression capabilities reject self-aliases at provide time", async () => {
    using session = withItxSession();
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });
    using project = itx.projects.create({ slug: `expr-self-${crypto.randomUUID()}` });

    await expect(
      project.provideCapability({
        expression: ["selfAlias"],
        path: ["selfAlias"],
        type: "itx-expression",
      }),
    ).rejects.toThrow(/cannot reference its own mount path/);
    await expect(
      project.provideCapability({
        expression: ["nested", "selfAlias", "extra"],
        path: ["nested", "selfAlias"],
        type: "itx-expression",
      }),
    ).rejects.toThrow(/cannot reference its own mount path/);
  });

  test("Project repos, workers, runScript, and dynamic worker refs compose", async () => {
    using session = withItxSession();
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });

    using project = itx.projects.create({ slug: "dynamic-worker-project" });
    const description = await project.describe();

    const scriptResult = await project.runScript(`async (itx) => {
      const response = await itx.worker.fetch(new Request("https://example.com/script"));
      return {
        repo: await itx.repo.whoami(),
        worker: await response.text(),
      };
    }`);
    expect(scriptResult.result).toEqual({
      repo: `repo ${description.projectId}:/`,
      worker: "project worker fetched /script",
    });

    const commit = await project.repo.commitFiles({
      changes: [
        {
          path: "worker.js",
          content: `
            import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

            export default class ProjectWorker extends WorkerEntrypoint {
              fetch(req) {
                return new Response(\`updated project worker fetched \${new URL(req.url).pathname}\`);
              }

              someMethod() {
                return {
                  projectId: ${JSON.stringify(description.projectId)},
                  source: "committed-worker",
                };
              }

              processEvent(input) {
                console.log("updated project worker processed", input.event.type);
              }
            }

            export class CounterDurableObject extends DurableObject {
              async increment() {
                const n = ((this.ctx.storage.kv.get("n")) ?? 0) + 1;
                this.ctx.storage.kv.put("n", n);
                return n;
              }

              async current() {
                return this.ctx.storage.kv.get("n") ?? 0;
              }
            }

            export class DatabaseDurableObject extends DurableObject {
              sql(query, ...bindings) {
                return this.ctx.storage.sql.exec(query, ...bindings).toArray();
              }
            }
          `,
        },
      ],
      message: "Add someMethod to project worker",
    });
    expect(commit).toMatchObject({
      branch: "main",
      changedPaths: ["worker.js"],
      noChanges: false,
    });
    expect(commit.commitOid).toMatch(/^[0-9a-f]{40}$/);
    // @ts-expect-error - dynamic project worker method from committed source
    expect(await project.worker.someMethod()).toEqual({
      projectId: description.projectId,
      source: "committed-worker",
    });

    using explicitWorker = project.workers.get({
      path: "/",
      source: {
        repoPath: "/",
        sourcePath: "worker.js",
        type: "repo",
      },
      type: "stateless",
    }) as unknown as {
      someMethod(): Promise<{ projectId: string; source: string }>;
    } & Disposable;
    expect(await explicitWorker.someMethod()).toEqual({
      projectId: description.projectId,
      source: "committed-worker",
    });

    using directDb = project.workers.get({
      className: "DatabaseDurableObject",
      durableWorkerKey: `direct-db-${crypto.randomUUID()}`,
      path: "/",
      source: {
        repoPath: "/",
        sourcePath: "worker.js",
        type: "repo",
      },
      type: "stateful",
    }) as unknown as {
      sql(query: string, ...bindings: unknown[]): Promise<Array<Record<string, unknown>>>;
    } & Disposable;
    await directDb.sql("CREATE TABLE messages (body TEXT)");
    await directDb.sql("INSERT INTO messages VALUES (?)", "hello");
    expect(await directDb.sql("SELECT body FROM messages")).toEqual([{ body: "hello" }]);
    using _probeProvision = await project.provideCapability({
      expression: [
        "workers",
        [
          "get",
          {
            entrypoint: "ProbeEntrypoint",
            path: "/",
            source: {
              mainModule: "probe.js",
              modules: {
                "probe.js": `
                  import { WorkerEntrypoint } from "cloudflare:workers";

                  export class ProbeEntrypoint extends WorkerEntrypoint {
                    async inspect() {
                      const project = await this.env.ITX.get();
                      const repo = await project.repo;
                      return {
                        repo: await repo.whoami(),
                      };
                    }
                  }
                `,
              },
              type: "inline",
            },
            type: "stateless",
          },
        ],
      ],
      path: ["probe"],
      type: "itx-expression",
    });
    // @ts-expect-error - dynamic capability root
    expect(await project.probe.inspect()).toEqual({
      repo: `repo ${description.projectId}:/`,
    });

    using _projectWorkerRefProvision = await project.provideCapability({
      expression: [
        "workers",
        [
          "get",
          {
            path: "/",
            source: {
              repoPath: "/",
              sourcePath: "worker.js",
              type: "repo",
            },
            type: "stateless",
          },
        ],
      ],
      path: ["projectWorkerRef"],
      type: "itx-expression",
    });
    // @ts-expect-error - dynamic capability root
    const workerRefResponse = await project.projectWorkerRef.fetch(
      new Request("https://example.com/ref"),
    );
    expect(await workerRefResponse.text()).toBe("updated project worker fetched /ref");

    using _counterFacetProvision = await project.provideCapability({
      expression: [
        "workers",
        [
          "get",
          {
            className: "CounterDurableObject",
            durableWorkerKey: `counter-facet-${crypto.randomUUID()}`,
            path: "/",
            source: {
              repoPath: "/",
              sourcePath: "worker.js",
              type: "repo",
            },
            type: "stateful",
          },
        ],
      ],
      path: ["counterFacet"],
      type: "itx-expression",
    });
    // @ts-expect-error - dynamic capability root
    expect(await project.counterFacet.increment()).toBe(1);
    // @ts-expect-error - dynamic capability root
    expect(await project.counterFacet.current()).toBe(1);

    using _dbProvision = await project.provideCapability({
      expression: [
        "workers",
        [
          "get",
          {
            className: "DatabaseDurableObject",
            durableWorkerKey: `mounted-db-${crypto.randomUUID()}`,
            path: "/",
            source: {
              repoPath: "/",
              sourcePath: "worker.js",
              type: "repo",
            },
            type: "stateful",
          },
        ],
      ],
      path: ["db"],
      type: "itx-expression",
    });
    // @ts-expect-error - dynamic database capability mounted by this test.
    await project.db.sql("CREATE TABLE records (value TEXT)");
    // @ts-expect-error - dynamic database capability mounted by this test.
    await project.db.sql("INSERT INTO records VALUES (?)", "mounted");
    // @ts-expect-error - dynamic database capability mounted by this test.
    expect(await project.db.sql("SELECT value FROM records")).toEqual([{ value: "mounted" }]);
  });

  test("repo worker source projection is cleared when the main worker file is deleted", async () => {
    using session = withItxSession();
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });

    using project = itx.projects.create({ slug: "deleted-worker-source-projection" });
    const warmResponse = await project.worker.fetch(new Request("https://example.com/warm"));
    expect(await warmResponse.text()).toBe("project worker fetched /warm");

    await project.repo.commitFiles({
      changes: [{ delete: true, path: "worker.js" }],
      message: "Delete default project worker",
    });

    await expect(project.worker.fetch(new Request("https://example.com/warm"))).rejects.toThrow();
  });

  test("Worker expression capabilities dispatch nested RpcTarget paths", async () => {
    const marker = crypto.randomUUID();
    using session = withItxSession();
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });
    using project = itx.projects.create({ slug: `worker-flatten-${marker}` });

    const source = {
      mainModule: "router.js",
      modules: {
        "router.js": `
          import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

          class ToolsTarget extends RpcTarget {
            constructor(kind) {
              super();
              this.kind = kind;
            }

            echo(input) {
              return {
                args: [input],
                kind: this.kind,
                marker: ${JSON.stringify(marker)},
                path: ["tools", "echo"],
              };
            }
          }

          export class RouterEntrypoint extends WorkerEntrypoint {
            get tools() {
              return new ToolsTarget("stateless");
            }

            root(input) {
              return {
                args: [input],
                kind: "stateless",
                marker: ${JSON.stringify(marker)},
                path: ["root"],
              };
            }
          }

          export class RouterDurableObject extends DurableObject {
            get tools() {
              return new ToolsTarget("stateful");
            }
          }
        `,
      },
      type: "inline",
    } as const;

    using _statelessRouterProvision = await project.provideCapability({
      expression: [
        "workers",
        [
          "get",
          {
            entrypoint: "RouterEntrypoint",
            path: "/",
            source,
            type: "stateless",
          },
        ],
      ],
      path: ["statelessRouter"],
      type: "itx-expression",
    });
    // @ts-expect-error - dynamic capability root
    expect(await project.statelessRouter.tools.echo("hello")).toEqual({
      args: ["hello"],
      kind: "stateless",
      marker,
      path: ["tools", "echo"],
    });
    // @ts-expect-error - dynamic capability root
    expect(await project.statelessRouter.root("root")).toEqual({
      args: ["root"],
      kind: "stateless",
      marker,
      path: ["root"],
    });

    using _statefulRouterProvision = await project.provideCapability({
      expression: [
        "workers",
        [
          "get",
          {
            className: "RouterDurableObject",
            durableWorkerKey: `router-${crypto.randomUUID()}`,
            path: "/",
            source,
            type: "stateful",
          },
        ],
      ],
      path: ["statefulRouter"],
      type: "itx-expression",
    });
    // @ts-expect-error - dynamic capability root
    expect(await project.statefulRouter.tools.echo("hello")).toEqual({
      args: ["hello"],
      kind: "stateful",
      marker,
      path: ["tools", "echo"],
    });
  });

  test("Dynamic workers can return RpcTarget capabilities that keep chaining", async () => {
    using session = withItxSession();
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });
    using project = itx.projects.create({ slug: `returned-rpc-target-${crypto.randomUUID()}` });

    type ReturnedTool = {
      child: { value(): Promise<{ label: string; via: string }> };
      greet(name: string): Promise<{ greeting: string; via: string }>;
    };
    type FactoryWorker = Disposable & {
      defaultTool: ReturnedTool;
      makeTool(label: string): PromiseLike<ReturnedTool> & ReturnedTool;
    };

    const source = {
      mainModule: "returned-rpc-target.js",
      modules: {
        "returned-rpc-target.js": `
          import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

          class ChildTarget extends RpcTarget {
            constructor(label) {
              super();
              this.label = label;
            }

            value() {
              return { label: this.label, via: "child-target" };
            }
          }

          class ToolTarget extends RpcTarget {
            constructor(label) {
              super();
              this.label = label;
            }

            greet(name) {
              return { greeting: this.label + ":" + name, via: "tool-target" };
            }

            get child() {
              return new ChildTarget(this.label);
            }
          }

          export class FactoryEntrypoint extends WorkerEntrypoint {
            get defaultTool() {
              return new ToolTarget("stateless-getter");
            }

            makeTool(label) {
              return new ToolTarget(label);
            }
          }

          export class FactoryDurableObject extends DurableObject {
            get defaultTool() {
              return new ToolTarget("stateful-getter");
            }

            makeTool(label) {
              return new ToolTarget(label);
            }
          }
        `,
      },
      type: "inline",
    } as const;

    using statelessWorker = project.workers.get({
      entrypoint: "FactoryEntrypoint",
      path: "/",
      source,
      type: "stateless",
    }) as unknown as FactoryWorker;
    const statelessTool = await statelessWorker.makeTool("stateless-awaited");
    expect(await statelessTool.greet("Ada")).toEqual({
      greeting: "stateless-awaited:Ada",
      via: "tool-target",
    });
    expect(await statelessTool.child.value()).toEqual({
      label: "stateless-awaited",
      via: "child-target",
    });
    expect(await statelessWorker.makeTool("stateless-pipelined").greet("Bob")).toEqual({
      greeting: "stateless-pipelined:Bob",
      via: "tool-target",
    });
    expect(await statelessWorker.defaultTool.greet("Grace")).toEqual({
      greeting: "stateless-getter:Grace",
      via: "tool-target",
    });
    expect(await statelessWorker.defaultTool.child.value()).toEqual({
      label: "stateless-getter",
      via: "child-target",
    });

    using statefulWorker = project.workers.get({
      className: "FactoryDurableObject",
      durableWorkerKey: `returned-target-${crypto.randomUUID()}`,
      path: "/",
      source,
      type: "stateful",
    }) as unknown as FactoryWorker;
    const statefulTool = await statefulWorker.makeTool("stateful-awaited");
    expect(await statefulTool.greet("Ada")).toEqual({
      greeting: "stateful-awaited:Ada",
      via: "tool-target",
    });
    expect(await statefulTool.child.value()).toEqual({
      label: "stateful-awaited",
      via: "child-target",
    });
    expect(await statefulWorker.makeTool("stateful-pipelined").greet("Bob")).toEqual({
      greeting: "stateful-pipelined:Bob",
      via: "tool-target",
    });
    expect(await statefulWorker.defaultTool.greet("Grace")).toEqual({
      greeting: "stateful-getter:Grace",
      via: "tool-target",
    });
    expect(await statefulWorker.defaultTool.child.value()).toEqual({
      label: "stateful-getter",
      via: "child-target",
    });
  });

  test("Worker capabilities cover project/agent, stateful/stateless, repo/inline refs and env.ITX cross-calls", async () => {
    using session = withItxSession();
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });

    using project = itx.projects.create({ slug: "worker-capability-matrix" });
    const { projectId } = await project.describe();
    const agentPath = `/agents/worker-capability-${crypto.randomUUID()}`;
    using agent = project.agents.get(agentPath);

    await project.repo.commitFiles({
      changes: [
        {
          path: "worker.js",
          content: `
            import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

            export default class ProjectWorker extends WorkerEntrypoint {
              fetch(req) {
                return new Response(\`matrix project worker \${new URL(req.url).pathname}\`);
              }

              processEvent(input) {
                console.log("matrix project worker processed", input.event.type);
              }
            }

            export class RepoProjectCounterDurableObject extends DurableObject {
              async increment(label) {
                const count = ((this.ctx.storage.kv.get("count")) ?? 0) + 1;
                this.ctx.storage.kv.put("count", count);
                const project = await this.env.ITX.get();
                const description = await project.describe();
                return {
                  count,
                  label,
                  scope: \`project:\${description.projectId}\`,
                };
              }
            }

            export class RepoAgentEntrypoint extends WorkerEntrypoint {
              async echo(label) {
                const itx = await this.env.ITX.get();
                return {
                  label,
                  whoami: await itx.agent.whoami(),
                };
              }
            }
          `,
        },
      ],
      message: "Add worker capability matrix fixtures",
    });

    const repoWorkerSource = {
      repoPath: "/",
      sourcePath: "worker.js",
      type: "repo",
    } as const;
    const inlineProjectStateless: DynamicWorkerRef = {
      entrypoint: "InlineProjectEntrypoint",
      path: "/",
      source: {
        mainModule: "inline-project.js",
        modules: {
          "inline-project.js": `
            import { WorkerEntrypoint } from "cloudflare:workers";

            export class InlineProjectEntrypoint extends WorkerEntrypoint {
              async describeScope() {
                const project = await this.env.ITX.get();
                const description = await project.describe();
                return {
                  projectId: description.projectId,
                  via: "inline-project-stateless",
                };
              }

              async callRepoCounter(label) {
                const project = await this.env.ITX.get();
                return await project.repoCounter.increment(label);
              }
            }
          `,
        },
        type: "inline",
      },
      type: "stateless",
    };
    const inlineAgentStateful: DynamicWorkerRef = {
      className: "InlineAgentCounterDurableObject",
      durableWorkerKey: `inline-agent-counter-${crypto.randomUUID()}`,
      path: agentPath,
      source: {
        mainModule: "inline-agent-counter.js",
        modules: {
          "inline-agent-counter.js": `
            import { DurableObject } from "cloudflare:workers";

            export class InlineAgentCounterDurableObject extends DurableObject {
              async increment(label) {
                const count = ((this.ctx.storage.kv.get("count")) ?? 0) + 1;
                this.ctx.storage.kv.put("count", count);
                const itx = await this.env.ITX.get();
                return {
                  count,
                  label,
                  whoami: await itx.agent.whoami(),
                };
              }

              async callRepoAgent(label) {
                const itx = await this.env.ITX.get();
                return await itx.agent.repoAgent.echo(label);
              }
            }
          `,
        },
        type: "inline",
      },
      type: "stateful",
    };

    using _repoCounterProvision = await project.provideCapability({
      expression: [
        "workers",
        [
          "get",
          {
            className: "RepoProjectCounterDurableObject",
            durableWorkerKey: `repo-project-counter-${crypto.randomUUID()}`,
            path: "/",
            source: repoWorkerSource,
            type: "stateful",
          },
        ],
      ],
      path: ["repoCounter"],
      type: "itx-expression",
    });
    using _inlineProjectProvision = await project.provideCapability({
      expression: ["workers", ["get", inlineProjectStateless]],
      path: ["inlineProject"],
      type: "itx-expression",
    });
    using _repoAgentProvision = await agent.provideCapability({
      expression: [
        "workers",
        [
          "get",
          {
            entrypoint: "RepoAgentEntrypoint",
            path: agentPath,
            source: repoWorkerSource,
            type: "stateless",
          },
        ],
      ],
      path: ["repoAgent"],
      type: "itx-expression",
    });
    using _inlineCounterProvision = await agent.provideCapability({
      expression: ["workers", ["get", inlineAgentStateful]],
      path: ["inlineCounter"],
      type: "itx-expression",
    });

    const projectCapabilities = project as typeof project & {
      inlineProject: {
        callRepoCounter(label: string): Promise<{ count: number; label: string; scope: string }>;
        describeScope(): Promise<{ projectId: string; via: string }>;
      };
      repoCounter: {
        increment(label: string): Promise<{ count: number; label: string; scope: string }>;
      };
    };
    const agentCapabilities = agent as typeof agent & {
      inlineCounter: {
        callRepoAgent(label: string): Promise<{ label: string; whoami: string }>;
        increment(label: string): Promise<{ count: number; label: string; whoami: string }>;
      };
      repoAgent: {
        echo(label: string): Promise<{ label: string; whoami: string }>;
      };
    };

    expect(await projectCapabilities.inlineProject.describeScope()).toEqual({
      projectId,
      via: "inline-project-stateless",
    });
    expect(await projectCapabilities.repoCounter.increment("direct-project-durable")).toEqual({
      count: 1,
      label: "direct-project-durable",
      scope: `project:${projectId}`,
    });
    expect(await projectCapabilities.inlineProject.callRepoCounter("project-cross-call")).toEqual({
      count: 2,
      label: "project-cross-call",
      scope: `project:${projectId}`,
    });

    expect(await agentCapabilities.repoAgent.echo("direct-agent-stateless")).toEqual({
      label: "direct-agent-stateless",
      whoami: `agent ${projectId}:${agentPath}`,
    });
    expect(await agentCapabilities.inlineCounter.increment("direct-agent-durable")).toEqual({
      count: 1,
      label: "direct-agent-durable",
      whoami: `agent ${projectId}:${agentPath}`,
    });
    expect(await agentCapabilities.inlineCounter.callRepoAgent("agent-cross-call")).toEqual({
      label: "agent-cross-call",
      whoami: `agent ${projectId}:${agentPath}`,
    });
  });

  test("Agent scripts can send web-chat messages and call project tools", async () => {
    using session = withItxSession();
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });

    using project = itx.projects.create({ slug: "agent-project-tool" });
    const agentPath = `/agents/project-tool-${crypto.randomUUID()}`;
    using agent = project.agents.get(agentPath);

    using _projectToolProvision = await project.provideCapability({
      path: ["projectTool"],
      type: "live",
      capability: {
        format(input: { text: string }) {
          return `project tool saw ${input.text}`;
        },
      },
    });

    const projectToolReply = agent.stream.waitForEvent({
      eventTypes: [AGENT_WEB_MESSAGE_SENT_TYPE],
      predicate: (event) => event.payload?.message === "project tool saw project-capability",
      timeoutMs: 30_000,
    });

    await agent.stream.append({
      type: AGENT_OUTPUT_ADDED_TYPE,
      payload: {
        content: fencedAgentScript(`
          async (itx) => {
            const message = await itx.projectTool.format({ text: "project-capability" });
            await itx.chat.sendMessage({ message });
          }
        `),
      },
    });

    expect(await projectToolReply).toMatchObject({
      type: AGENT_WEB_MESSAGE_SENT_TYPE,
      payload: { message: "project tool saw project-capability" },
    });

    const events = await agent.stream.getEvents();
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        AGENT_OUTPUT_ADDED_TYPE,
        "events.iterate.com/itx/script-execution-requested",
        "events.iterate.com/itx/script-execution-completed",
        AGENT_WEB_MESSAGE_SENT_TYPE,
        "events.iterate.com/agent/input-added",
      ]),
    );
  });

  test("New agent streams install processors and replay existing child events", async () => {
    using session = withItxSession();
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });

    const marker = `agent-auto-bootstrap-${crypto.randomUUID()}`;
    using project = itx.projects.create({ slug: `agent-auto-bootstrap-${marker}` });
    const agentPath = `/agents/auto-bootstrap-${crypto.randomUUID()}`;
    using agent = project.agents.get(agentPath);

    const content = fencedAgentScript(`
      async (itx) => {
        await itx.chat.sendMessage({ message: ${JSON.stringify(marker)} });
      }
    `);
    const [historicalOutput] = await agent.stream.append({
      type: AGENT_OUTPUT_ADDED_TYPE,
      payload: { content },
    });

    const replayedReply = await agent.stream.waitForEvent({
      afterOffset: historicalOutput.offset,
      eventTypes: [AGENT_WEB_MESSAGE_SENT_TYPE],
      predicate: (event) => event.payload?.message === marker,
      timeoutMs: 30_000,
    });

    expect(replayedReply).toMatchObject({
      type: AGENT_WEB_MESSAGE_SENT_TYPE,
      payload: { message: marker },
    });

    const events = await agent.stream.getEvents({ afterOffset: 0 });
    const outputOffset = events.find(
      (event) => event.type === AGENT_OUTPUT_ADDED_TYPE && event.payload?.content === content,
    )?.offset;
    const agentSubscriptionOffset = events.find(
      (event) =>
        event.type === "events.iterate.com/stream/subscription-configured" &&
        (event.payload as { subscriptionKey?: string; subscriber?: { type?: string } }).subscriber
          ?.type === "agent" &&
        String((event.payload as { subscriptionKey?: string }).subscriptionKey).endsWith("#agent"),
    )?.offset;
    const cloudflareAiSubscriptionOffset = events.find(
      (event) =>
        event.type === "events.iterate.com/stream/subscription-configured" &&
        (event.payload as { subscriptionKey?: string; subscriber?: { type?: string } }).subscriber
          ?.type === "agent" &&
        String((event.payload as { subscriptionKey?: string }).subscriptionKey).endsWith(
          "#cloudflare-ai",
        ),
    )?.offset;
    const itxSubscriptionOffset = events.find(
      (event) =>
        event.type === "events.iterate.com/stream/subscription-configured" &&
        (event.payload as { subscriber?: { type?: string } }).subscriber?.type === "itx",
    )?.offset;
    const scriptRequestedOffset = events.find(
      (event) => event.type === "events.iterate.com/itx/script-execution-requested",
    )?.offset;
    const modelSelectionOffset = events.find(
      (event) => event.type === "events.iterate.com/agent/llm-provider-selected",
    )?.offset;

    expect(outputOffset).toBe(historicalOutput.offset);
    expect(agentSubscriptionOffset).toBeGreaterThan(historicalOutput.offset);
    expect(cloudflareAiSubscriptionOffset).toBeGreaterThan(historicalOutput.offset);
    expect(itxSubscriptionOffset).toBeGreaterThan(historicalOutput.offset);
    expect(modelSelectionOffset).toBeGreaterThan(historicalOutput.offset);
    expect(scriptRequestedOffset).toBeGreaterThan(agentSubscriptionOffset!);
  });

  test("Agent-only dynamic worker and durable object capabilities run from LLM scripts", async () => {
    using session = withItxSession();
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });

    using project = itx.projects.create({ slug: "agent-only-tools" });
    const { projectId } = await project.describe();
    const agentPath = `/agents/agent-only-${crypto.randomUUID()}`;
    using agent = project.agents.get(agentPath);
    const durableWorkerKey = `agent-counter-${crypto.randomUUID()}`;

    using _agentProbeProvision = await agent.provideCapability({
      expression: [
        "workers",
        [
          "get",
          {
            entrypoint: "AgentProbeEntrypoint",
            path: agentPath,
            source: {
              mainModule: "agent-probe.js",
              modules: {
                "agent-probe.js": `
                  import { WorkerEntrypoint } from "cloudflare:workers";

                  export class AgentProbeEntrypoint extends WorkerEntrypoint {
                    async inspect(input) {
                      const itx = await this.env.ITX.get();
                      return {
                        input,
                        projectId: ${JSON.stringify(projectId)},
                        whoami: await itx.agent.whoami(),
                      };
                    }
                  }
                `,
              },
              type: "inline",
            },
            type: "stateless",
          },
        ],
      ],
      path: ["agentProbe"],
      type: "itx-expression",
    });
    using _agentCounterProvision = await agent.provideCapability({
      expression: [
        "workers",
        [
          "get",
          {
            className: "CounterDurableObject",
            durableWorkerKey,
            path: agentPath,
            source: {
              repoPath: "/",
              sourcePath: "worker.js",
              type: "repo",
            },
            type: "stateful",
          },
        ],
      ],
      path: ["agentCounter"],
      type: "itx-expression",
    });

    await expect(
      // @ts-expect-error - proves agent-provided capabilities are not mounted on the project.
      project.agentProbe.inspect("project should not see this"),
    ).rejects.toThrow(/no capability "agentProbe.inspect"/);

    const scriptReply = agent.stream.waitForEvent({
      eventTypes: [AGENT_WEB_MESSAGE_SENT_TYPE],
      predicate: (event) =>
        typeof event.payload?.message === "string" &&
        event.payload.message.includes(durableWorkerKey),
      timeoutMs: 30_000,
    });

    await agent.stream.append({
      type: AGENT_OUTPUT_ADDED_TYPE,
      payload: {
        content: fencedAgentScript(`
          async (itx) => {
            const probe = await itx.agent.agentProbe.inspect("agent-only");
            const first = await itx.agent.agentCounter.increment();
            const current = await itx.agent.agentCounter.current();
            await itx.chat.sendMessage({
              message: JSON.stringify({
                durableWorkerKey: ${JSON.stringify(durableWorkerKey)},
                current,
                first,
                probe,
              }),
            });
          }
        `),
      },
    });

    const event = await scriptReply;
    const message = JSON.parse(String(event.payload?.message)) as {
      current: number;
      durableWorkerKey: string;
      first: number;
      probe: { input: string; projectId: string; whoami: string };
    };
    expect(message).toEqual({
      current: 1,
      durableWorkerKey,
      first: 1,
      probe: {
        input: "agent-only",
        projectId,
        whoami: `agent ${projectId}:${agentPath}`,
      },
    });
  });

  test("Dynamic worker env.ITX.get() is scoped by project and agent host path", async () => {
    using session = withItxSession();
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });

    using project = itx.projects.create({ slug: "dynamic-worker-scope-cache" });
    const { projectId } = await project.describe();
    const agentPath = `/agents/scope-cache-${crypto.randomUUID()}`;
    using agent = project.agents.get(agentPath);
    const scopeProbeWorkerRef = (path: string) => ({
      entrypoint: "ScopeProbeEntrypoint",
      path,
      source: {
        mainModule: "scope-probe.js",
        modules: {
          "scope-probe.js": `
            import { WorkerEntrypoint } from "cloudflare:workers";

            export class ScopeProbeEntrypoint extends WorkerEntrypoint {
              async projectScope() {
                const itx = await this.env.ITX.get();
                const description = await itx.describe();
                return { kind: "project", projectId: description.projectId };
              }

              async agentScope() {
                const itx = await this.env.ITX.get();
                return { kind: "agent", whoami: await itx.agent.whoami() };
              }
            }
          `,
        },
        type: "inline" as const,
      },
      type: "stateless" as const,
    });

    using _projectScopeProbeProvision = await project.provideCapability({
      expression: ["workers", ["get", scopeProbeWorkerRef("/")]],
      path: ["scopeProbe"],
      type: "itx-expression",
    });
    using _agentScopeProbeProvision = await agent.provideCapability({
      expression: ["workers", ["get", scopeProbeWorkerRef(agentPath)]],
      path: ["scopeProbe"],
      type: "itx-expression",
    });

    // @ts-expect-error - dynamic project capability mounted by this test.
    expect(await project.scopeProbe.projectScope()).toEqual({ kind: "project", projectId });
    // @ts-expect-error - dynamic agent capability mounted by this test.
    expect(await agent.scopeProbe.agentScope()).toEqual({
      kind: "agent",
      whoami: `agent ${projectId}:${agentPath}`,
    });
  });

  test("Dynamic project worker processEvent can cross-post project events", async () => {
    using session = withItxSession();
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });

    using project = itx.projects.create({ slug: "project-worker-process-event" });
    const marker = `cross-post-${crypto.randomUUID()}`;

    await project.repo.commitFiles({
      changes: [
        {
          path: "worker.js",
          content: `
            import { WorkerEntrypoint } from "cloudflare:workers";

            export default class ProjectWorker extends WorkerEntrypoint {
              fetch() {
                return new Response("ok");
              }

              async processEvent({ event }) {
                if (event.metadata?.crossPostMarker !== ${JSON.stringify(marker)}) return;

                const project = await this.env.ITX.get();
                await project.streams.get("/cross-posted").append({
                  type: "events.iterate.com/test/cross-posted",
                  idempotencyKey: \`project-worker-cross-post:\${event.offset}\`,
                  metadata: {
                    crossPostedBy: "project-worker",
                    marker: event.metadata.crossPostMarker,
                    sourceOffset: event.offset,
                  },
                  payload: {
                    originalPayload: event.payload ?? null,
                    originalType: event.type,
                  },
                });
              }
            }
          `,
        },
      ],
      message: "Cross-post selected project events from processEvent",
    });

    const crossPosted = project.streams.get("/cross-posted");
    const copied = crossPosted.waitForEvent({
      eventTypes: ["events.iterate.com/test/cross-posted"],
      timeoutMs: 30_000,
    });

    const [sourceEvent] = await project.streams.get("/").append({
      type: "events.iterate.com/test/source",
      metadata: { crossPostMarker: marker },
      payload: { text: "hello from root" },
    });

    const copiedEvent = await copied;
    expect(copiedEvent.metadata).toMatchObject({
      crossPostedBy: "project-worker",
      marker,
      sourceOffset: sourceEvent.offset,
    });
    expect(copiedEvent.payload).toEqual({
      originalPayload: { text: "hello from root" },
      originalType: "events.iterate.com/test/source",
    });
  });

  test("Project stream subscribe can observe project worker processEvent forwarding", async () => {
    using session = withItxSession();
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });

    const marker = crypto.randomUUID();
    const outputPath = `/worker-forwarding-output-${marker}`;
    const triggerPath = `/worker-forwarding-trigger-${marker}`;

    using project = itx.projects.create({ slug: `worker-forwarding-${marker}` });

    await project.repo.commitFiles({
      changes: [
        {
          path: "worker.js",
          content: `
            import { WorkerEntrypoint } from "cloudflare:workers";

            const OUTPUT_PATH = ${JSON.stringify(outputPath)};
            const TRIGGER_PATH = ${JSON.stringify(triggerPath)};
            const MARKER = ${JSON.stringify(marker)};
            const FORWARDED_EVENT_TYPE = ${JSON.stringify(PROJECT_WORKER_FORWARDED_EVENT_TYPE)};

            export default class ProjectWorker extends WorkerEntrypoint {
              fetch(req) {
                return new Response(\`forwarding test worker fetched \${new URL(req.url).pathname}\`);
              }

              async processEvent(input) {
                const event = input.event;
                if (event.type !== "events.iterate.com/stream/child-stream-created") return;
                if (event.payload.childPath !== TRIGGER_PATH) return;

                const project = await this.env.ITX.get();
                await project.streams.get(OUTPUT_PATH).append({
                  type: FORWARDED_EVENT_TYPE,
                  payload: {
                    childPath: event.payload.childPath,
                    marker: MARKER,
                    originalType: event.type,
                  },
                });
              }
            }
          `,
        },
      ],
      message: "Add forwarding test worker",
    });

    const outputStream = project.streams.get(outputPath);
    let storedSnapshot: StreamProcessorSnapshot<ProjectWorkerForwardingProbeState> | undefined;
    const processor = new ProjectWorkerForwardingProbeProcessor({
      readState: () => storedSnapshot,
      stream: outputStream as never,
      writeState: (snapshot) => {
        storedSnapshot = snapshot;
      },
    });

    const initial = await processor.snapshot();
    using subscription = await outputStream.subscribe({
      eventTypes: [PROJECT_WORKER_FORWARDED_EVENT_TYPE],
      processEventBatch: (batch) => processor.ingest(batch),
      replayAfterOffset: initial.offset,
      subscriber: {
        description: "minimal-itx-v4 e2e local project worker forwarding probe",
      },
    });

    await project.streams.get(triggerPath).append({
      type: "events.iterate.test/project-worker-forwarding-trigger",
      payload: { marker },
    });

    await processor.waitUntilEvent({
      predicate: (event) =>
        event.type === PROJECT_WORKER_FORWARDED_EVENT_TYPE && event.payload?.marker === marker,
      timeoutMs: 8_000,
    });
    expect(processor.state).toEqual({
      childPaths: [triggerPath],
      markers: [marker],
    });
    expect(storedSnapshot).toEqual({
      offset: expect.any(Number),
      state: {
        childPaths: [triggerPath],
        markers: [marker],
      },
    });

    await subscription.unsubscribe();
    const stateAtUnsubscribe = processor.state;
    await outputStream.append({
      type: PROJECT_WORKER_FORWARDED_EVENT_TYPE,
      payload: {
        childPath: outputPath,
        marker: `after-${marker}`,
        originalType: "manual",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(processor.state).toEqual(stateAtUnsubscribe);
  });

  test("Cap'n Web stream subscribe callback survives the stateless Worker proxy", async () => {
    const marker = crypto.randomUUID();
    const eventType = "events.iterate.test/capnweb-subscribe-callback-forwarded";
    const streamPath = `/capnweb-subscribe-callback-${marker}`;

    using session = withItxSession();
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });
    using project = itx.projects.create({ slug: `capnweb-subscribe-callback-${marker}` });
    using stream = project.streams.get(streamPath);
    const delivered: number[] = [];

    using subscription = await stream.subscribe({
      eventTypes: [eventType],
      processEventBatch: (batch) => {
        for (const event of batch.events) {
          if (event.type === eventType && event.payload?.marker === marker) {
            delivered.push(event.payload.sequence as number);
          }
        }
      },
      subscriber: {
        description: "minimal-itx-v4 e2e direct Cap'n Web callback forwarding probe",
      },
      subscriptionKey: `capnweb-callback-${marker}`,
    });
    const openedSubscriptionKey = await subscription.subscriptionKey;
    expect(openedSubscriptionKey).toBe(`capnweb-callback-${marker}`);

    await waitForCondition(
      async () => {
        const runtimeState = await stream.runtimeState();
        return runtimeState.runtime.connections[openedSubscriptionKey] !== undefined;
      },
      { description: "stream runtime to show the direct Cap'n Web callback connection" },
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    await stream.append({
      type: eventType,
      payload: { marker, sequence: 1 },
    });
    await stream.append({
      type: eventType,
      payload: { marker, sequence: 2 },
    });

    await waitForCondition(() => delivered.includes(1) && delivered.includes(2), {
      description: "Cap'n Web callback deliveries after subscribe returned",
    });
    expect(delivered).toEqual([1, 2]);

    await subscription.unsubscribe();
    await waitForCondition(
      async () => {
        const runtimeState = await stream.runtimeState();
        return runtimeState.runtime.connections[openedSubscriptionKey] === undefined;
      },
      { description: "stream runtime to remove the direct Cap'n Web callback connection" },
    );
    await stream.append({
      type: eventType,
      payload: { marker, sequence: 3 },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(delivered).toEqual([1, 2]);
  });

  test("Cap'n Web stream subscribe with the same key replaces the old callback", async () => {
    const marker = crypto.randomUUID();
    const eventType = "events.iterate.test/capnweb-subscribe-callback-replaced";
    const streamPath = `/capnweb-subscribe-replaced-${marker}`;
    const subscriptionKey = `capnweb-replaced-${marker}`;

    using session = withItxSession();
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });
    using project = itx.projects.create({ slug: `capnweb-subscribe-replaced-${marker}` });
    using stream = project.streams.get(streamPath);
    const first: number[] = [];
    const second: number[] = [];

    using firstSubscription = await stream.subscribe({
      eventTypes: [eventType],
      processEventBatch: (batch) => {
        first.push(
          ...batch.events
            .filter((event) => event.type === eventType && event.payload?.marker === marker)
            .map((event) => event.payload!.sequence as number),
        );
      },
      subscriptionKey,
    });
    using secondSubscription = await stream.subscribe({
      eventTypes: [eventType],
      processEventBatch: (batch) => {
        second.push(
          ...batch.events
            .filter((event) => event.type === eventType && event.payload?.marker === marker)
            .map((event) => event.payload!.sequence as number),
        );
      },
      subscriptionKey,
    });
    expect(await firstSubscription.subscriptionKey).toBe(subscriptionKey);
    expect(await secondSubscription.subscriptionKey).toBe(subscriptionKey);

    await firstSubscription.unsubscribe();
    await stream.append({
      type: eventType,
      payload: { marker, sequence: 1 },
    });

    await waitForCondition(() => second.includes(1), {
      description: "replacement subscriber delivery",
    });
    expect(first).toEqual([]);
    expect(second).toEqual([1]);

    await secondSubscription.unsubscribe();
  });

  test("Cap'n Web nested subscriber processor callbacks survive the stateless Worker proxy", async () => {
    const marker = crypto.randomUUID();
    const streamPath = `/capnweb-subscribe-nested-${marker}`;
    const subscriptionKey = `capnweb-nested-${marker}`;

    using session = withItxSession();
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });
    using project = itx.projects.create({ slug: `capnweb-subscribe-nested-${marker}` });
    using stream = project.streams.get(streamPath);
    using subscription = await stream.subscribe({
      processEventBatch: () => {},
      subscriber: {
        description: "minimal-itx-v4 e2e nested subscriber callback forwarding probe",
        processor: {
          announcement: {
            consumes: ["*"],
            description: "Nested callback forwarding probe",
            emits: [],
            ownedEvents: [],
            slug: "minimal-itx-v4.e2e.nested-callback-probe",
            version: "0.1.0",
          },
          getRuntimeState: () => ({
            runtime: { marker },
            snapshot: { offset: 123, state: { marker } },
          }),
        },
      },
      subscriptionKey,
    });

    await waitForCondition(
      async () => {
        const state = await stream.getProcessorRuntimeState({ subscriptionKey });
        return state?.runtime?.marker === marker && state.snapshot.offset === 123;
      },
      { description: "nested getRuntimeState callback after subscribe returned" },
    );

    await subscription.unsubscribe();
  });

  test("Nested plain-object live capability members survive after provideCapability returns", async () => {
    const marker = crypto.randomUUID();

    using providerSession = withItxSession();
    using providerItx = providerSession.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });
    using project = providerItx.projects.create({ slug: `nested-live-${marker}` });
    const { projectId } = await project.describe();

    using _toolsProvision = await project.provideCapability({
      path: ["tools"],
      type: "live",
      capability: {
        math: {
          add(a: number, b: number) {
            return { marker, sum: a + b };
          },
        },
      },
    });

    using callerSession = withItxSession();
    using callerItx = callerSession.authenticate({
      type: "token",
      token: {
        principal: "alice",
        projectScopes: [projectId],
        type: "user",
      },
    });
    using callerProject = callerItx.projects.get(projectId);

    // @ts-expect-error - dynamic capability root
    expect(await callerProject.tools.math.add(20, 22)).toEqual({ marker, sum: 42 });
  });

  test("Live capabilities reject the removed target spelling", async () => {
    using session = withItxSession();
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });
    using project = itx.projects.create({ slug: `removed-target-${crypto.randomUUID()}` });

    await expect(
      project.provideCapability({
        path: ["oldLive"],
        target: {
          value() {
            return "old spelling";
          },
        },
        type: "live",
      } as never),
    ).rejects.toThrow(/require "capability"/);
  });

  test("Live capability values may have a domain member named capability", async () => {
    const marker = crypto.randomUUID();

    using providerSession = withItxSession();
    using providerItx = providerSession.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });
    using project = providerItx.projects.create({ slug: `capability-field-live-${marker}` });
    const { projectId } = await project.describe();

    using _toolsProvision = await project.provideCapability({
      path: ["tools"],
      type: "live",
      capability: {
        capability: {
          echo(input: string) {
            return { input, marker, via: "domain-field" };
          },
        },
        status() {
          return { marker, via: "root-target" };
        },
      },
    });

    using callerSession = withItxSession();
    using callerItx = callerSession.authenticate({
      type: "token",
      token: {
        principal: "alice",
        projectScopes: [projectId],
        type: "user",
      },
    });
    using callerProject = callerItx.projects.get(projectId);

    // @ts-expect-error - dynamic capability root
    expect(await callerProject.tools.status()).toEqual({ marker, via: "root-target" });
    // @ts-expect-error - dynamic capability root
    expect(await callerProject.tools.capability.echo("ok")).toEqual({
      input: "ok",
      marker,
      via: "domain-field",
    });
  });

  test("Live bare function capabilities survive provideCapability return", async () => {
    const marker = crypto.randomUUID();

    using providerSession = withItxSession();
    using providerItx = providerSession.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });
    using project = providerItx.projects.create({ slug: `bare-function-live-${marker}` });
    const { projectId } = await project.describe();

    using _addProvision = await project.provideCapability({
      path: ["add"],
      type: "live",
      capability: (a: number, b: number) => ({ marker, sum: a + b }),
    });

    using callerSession = withItxSession();
    using callerItx = callerSession.authenticate({
      type: "token",
      token: {
        principal: "alice",
        projectScopes: [projectId],
        type: "user",
      },
    });
    using callerProject = callerItx.projects.get(projectId);

    // @ts-expect-error - dynamic capability root
    expect(await callerProject.add(20, 22)).toEqual({ marker, sum: 42 });
  });

  test("Top-level RpcTarget live capabilities dispatch by member path", async () => {
    class MathSdk extends RpcTarget {
      add(a: number, b: number) {
        return a + b;
      }
    }
    const marker = crypto.randomUUID();

    using providerSession = withItxSession();
    using providerItx = providerSession.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });
    using project = providerItx.projects.create({ slug: `rpc-target-live-${marker}` });
    const { projectId } = await project.describe();

    using _mathProvision = await project.provideCapability({
      path: ["math"],
      type: "live",
      capability: new MathSdk(),
    });

    using callerSession = withItxSession();
    using callerItx = callerSession.authenticate({
      type: "token",
      token: {
        principal: "alice",
        projectScopes: [projectId],
        type: "user",
      },
    });
    using callerProject = callerItx.projects.get(projectId);

    // @ts-expect-error - dynamic capability root
    expect(await callerProject.math.add(20, 22)).toBe(42);
  });

  test("RpcTarget live capabilities can dispatch through nested RpcTarget getters", async () => {
    const marker = crypto.randomUUID();

    class ChatSdk extends RpcTarget {
      postMessage(input: { channel: string; text: string }) {
        return {
          input,
          marker,
          via: "nested-rpc-target-getter",
        };
      }
    }

    class SlackSdk extends RpcTarget {
      get chat() {
        return new ChatSdk();
      }

      invokeCapability() {
        throw new Error("flattened dispatch should not be used in normal dispatch mode");
      }
    }

    using providerSession = withItxSession();
    using providerItx = providerSession.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });
    using project = providerItx.projects.create({ slug: `nested-rpc-target-live-${marker}` });
    const { projectId } = await project.describe();

    await project.provideCapability({
      path: ["slack"],
      type: "live",
      capability: new SlackSdk(),
    });

    using callerSession = withItxSession();
    using callerItx = callerSession.authenticate({
      type: "token",
      token: {
        principal: "alice",
        projectScopes: [projectId],
        type: "user",
      },
    });
    using callerProject = callerItx.projects.get(projectId);

    // @ts-expect-error - dynamic capability root
    expect(await callerProject.slack.chat.postMessage({ channel: "C123", text: "hi" })).toEqual({
      input: { channel: "C123", text: "hi" },
      marker,
      via: "nested-rpc-target-getter",
    });
  });

  test("Flattened live capabilities receive the remaining member path", async () => {
    const marker = crypto.randomUUID();

    class Carrier extends RpcTarget {
      invokeCapability({ args, path }: { args: unknown[]; path: string[] }) {
        return { args, marker, path };
      }
    }

    using providerSession = withItxSession();
    using providerItx = providerSession.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });
    using project = providerItx.projects.create({ slug: `path-call-live-${marker}` });
    const { projectId } = await project.describe();

    using _carrierProvision = await project.provideCapability({
      path: ["carrier"],
      flattenNestedPaths: true,
      type: "live",
      capability: new Carrier(),
    });

    using callerSession = withItxSession();
    using callerItx = callerSession.authenticate({
      type: "token",
      token: {
        principal: "alice",
        projectScopes: [projectId],
        type: "user",
      },
    });
    using callerProject = callerItx.projects.get(projectId);

    // @ts-expect-error - dynamic capability root
    expect(await callerProject.carrier.tools.echo("hello")).toEqual({
      args: ["hello"],
      marker,
      path: ["tools", "echo"],
    });
  });

  test("Successful live capability replacement uses the new target", async () => {
    const marker = crypto.randomUUID();

    using session = withItxSession();
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });
    using project = itx.projects.create({ slug: `replace-live-${marker}` });

    using _oldProvision = await project.provideCapability({
      path: ["replaceProbe"],
      type: "live",
      capability: {
        value() {
          return `old:${marker}`;
        },
      },
    });

    // @ts-expect-error - dynamic capability root
    expect(await project.replaceProbe.value()).toBe(`old:${marker}`);

    using _newProvision = await project.provideCapability({
      path: ["replaceProbe"],
      type: "live",
      capability: {
        value() {
          return `new:${marker}`;
        },
      },
    });
    // @ts-expect-error - dynamic capability root
    expect(await project.replaceProbe.value()).toBe(`new:${marker}`);
  });

  test("ITX expression replacement records the recipe without evaluating it", async () => {
    const marker = crypto.randomUUID();

    using session = withItxSession();
    using itx = session.authenticate({
      type: "trusted-internal",
      token: TRUSTED_INTERNAL_ITX_TOKEN,
    });
    using project = itx.projects.create({ slug: `failed-replace-live-${marker}` });

    using _provision = await project.provideCapability({
      path: ["replaceProbe"],
      type: "live",
      capability: {
        value() {
          return `old:${marker}`;
        },
      },
    });

    using _replacement = await project.provideCapability({
      expression: ["workers", ["get", { source: { type: "inline" }, type: "stateless" }]],
      path: ["replaceProbe"],
      type: "itx-expression",
    });
    const description = await project.describe();
    expect(description.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["replaceProbe"],
          type: "itx-expression",
        }),
      ]),
    );

    // @ts-expect-error - dynamic capability root
    await expect(project.replaceProbe.value()).rejects.toThrow();
  });

  test("Authenticated project can provide the Slack SDK as nested dotted functions", async () => {
    const mock = await startMockSlack();
    try {
      using session = withItxSession();
      using itx = session.authenticate({
        type: "trusted-internal",
        token: TRUSTED_INTERNAL_ITX_TOKEN,
      });

      using project = itx.projects.create({ slug: "slack-project" });
      const description = await project.describe();

      const slack = new WebClient("xoxb-not-a-real-token", {
        retryConfig: { retries: 0 },
        slackApiUrl: mock.url,
      });

      using provision = await project.provideCapability({
        path: ["slack"],
        flattenNestedPaths: true,
        type: "live",
        capability: new PathFunctionTarget(slack),
      });

      using callerSession = withItxSession();
      using callerItx = callerSession.authenticate({
        type: "token",
        token: {
          projectScopes: [description.projectId],
          type: "user",
          principal: "alice",
        },
      });
      using callerProject = callerItx.projects.get(description.projectId);

      // @ts-expect-error - dynamic capability root
      const posted = await callerProject.slack.chat.postMessage({
        channel: "C123",
        text: "hi from itx",
      });
      expect(posted).toMatchObject({
        channel: "C123",
        message: { text: "hi from itx" },
        ok: true,
        via: "mock-slack-api",
      });

      // @ts-expect-error - dynamic capability root
      const users = await callerProject.slack.users.list();
      expect(users).toMatchObject({
        members: [
          { id: "U1", name: "ada" },
          { id: "U2", name: "grace" },
        ],
        ok: true,
        via: "mock-slack-api",
      });
      expect(mock.calls).toEqual(expect.arrayContaining(["chat.postMessage", "users.list"]));

      await provision.revoke();
      await expect(
        // @ts-expect-error - dynamic capability root
        callerProject.slack.chat.postMessage({ channel: "C123", text: "after revoke" }),
      ).rejects.toThrow(/no capability "slack.chat.postMessage"/);
    } finally {
      await mock.close();
    }
  });

  // This test is handy because it proves that we really only need one round trip to
  // take all the actions in this itx script
  test("Authenticated itx whoami and projects list complete in one HTTP batch", async () => {
    // oxlint-disable-next-line iterate/no-capnweb-http-batch -- if this cannot pipeline in one request, Cap'n Web rejects the batch.
    using session = newHttpBatchRpcSession<UnauthenticatedItx>(buildUrl({ path: "/api/itx" }));
    using itx = session.authenticate({
      type: "token",
      token: {
        principal: "alice",
        projectScopes: ["prj_alice", "prj_ref"],
        type: "user",
      },
    });
    // If we didn't do Promise.all, this wouldn't work - wouldn't be sent as part of the same batch
    const [principal, projects] = await Promise.all([itx.whoami(), itx.projects.list()]);
    expect(principal).toBe("alice");
    expect(projects).toEqual(["prj_alice", "prj_ref"]);

    // session is now finished - cannot be used again in batch http mode
    await expect(session.authenticate).rejects.toThrow();
  });

  // MAYBE dumb vibecoded test not sure
  test.skip("websocket transport pipelines a batch into a single round trip", async () => {
    // Pipelining proof for the *websocket* transport. The HTTP batch test above
    // proves it for one-shot batches; this one proves the live socket coalesces a
    // pipelined script into a single network round trip too.
    //
    // We measure round trips straight off the wire. test-helpers' onWebSocketMessage
    // hook records every frame with its direction, and capnweb sends each RPC call
    // as its own frame (a "push", plus a "pull" when the result is awaited). The
    // give-away of a round trip is therefore NOT the frame count but the
    // interleaving: a pipelined batch fires all of its outbound frames back to back
    // (one contiguous burst) before blocking on any reply, whereas awaiting between
    // calls forces a reply (an inbound frame) to land mid-stream and splits the
    // outbound frames into separate bursts. So: round trips === number of
    // contiguous outbound bursts.
    const countRoundTrips = (messages: readonly ItxWebSocketMessage[]): number => {
      let roundTrips = 0;
      let previousDirection: ItxWebSocketMessage[1] | undefined;
      for (const [, direction] of messages) {
        if (direction === "out" && previousDirection !== "out") roundTrips += 1;
        previousDirection = direction;
      }
      return roundTrips;
    };

    // Pipelined: authenticate + both reads are issued in the same tick, so every
    // outbound frame leaves before any reply is awaited -> one burst.
    const pipelined: ItxWebSocketMessage[] = [];
    {
      using session = withItxSession({ onWebSocketMessage: (m) => pipelined.push(m) });
      using itx = session.authenticate({
        type: "token",
        token: {
          principal: "alice",
          projectScopes: ["prj_alice", "prj_ref"],
          type: "user",
        },
      });
      const [principal, projects] = await Promise.all([itx.whoami(), itx.projects.list()]);
      expect(principal).toBe("alice");
      expect(projects).toEqual(["prj_alice", "prj_ref"]);
    }

    // Sequential: the same logical work, but each await blocks on a reply before
    // the next call goes out, so the inbound frame splits the outbound frames
    // into separate bursts -> more round trips.
    const sequential: ItxWebSocketMessage[] = [];
    {
      using session = withItxSession({ onWebSocketMessage: (m) => sequential.push(m) });
      using itx = session.authenticate({
        type: "token",
        token: {
          principal: "alice",
          projectScopes: ["prj_alice", "prj_ref"],
          type: "user",
        },
      });
      expect(await itx.whoami()).toBe("alice");
      expect(await itx.projects.list()).toEqual(["prj_alice", "prj_ref"]);
    }

    const pipelinedRoundTrips = countRoundTrips(pipelined);
    const sequentialRoundTrips = countRoundTrips(sequential);

    // The whole point: pipelining collapses the script to a single round trip.
    expect(pipelinedRoundTrips).toBe(1);
    // And it really is a saving over doing the same work one await at a time.
    expect(pipelinedRoundTrips).toBeLessThan(sequentialRoundTrips);
  });
});
