import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcTarget } from "capnweb";
import { describe, expect, test } from "vitest";
import type { EgressHttpsProxy, EgressHttpsProxyConnection } from "../../src/types.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

const EGRESS_PROOF_HEADER = "x-itx-egress-proof";
const EGRESS_PROXY_PINNED_CERT_SHA256_HEADER = "x-itx-egress-proxy-cert-sha256";

// A node-side egress proxy: it only dials TCP and shuttles bytes, exactly the
// EgressHttpsProxy contract. It records every byte so the test can prove the
// worker's TLS never leaked plaintext to it.
type ProxyObservation = {
  bytesTargetToWorker: number;
  bytesWorkerToTarget: number;
  firstWorkerToTarget: Uint8Array;
  host: string;
  port: number;
  targetToWorkerChunks: Uint8Array[];
  workerToTargetChunks: Uint8Array[];
};

class EgressProxyConnectionTarget extends RpcTarget implements EgressHttpsProxyConnection {
  readonly #observation: ProxyObservation;
  readonly #readQueue: Uint8Array[] = [];
  readonly #readWaiters: Array<{
    reject(error: unknown): void;
    resolve(chunk: Uint8Array | null): void;
  }> = [];
  readonly #socket: net.Socket;
  #closed = false;
  #error: unknown;

  constructor({ observation, socket }: { observation: ProxyObservation; socket: net.Socket }) {
    super();
    this.#observation = observation;
    this.#socket = socket;

    socket.on("data", (chunk: Buffer) => {
      const bytes = new Uint8Array(chunk);
      observation.bytesTargetToWorker += bytes.byteLength;
      observation.targetToWorkerChunks.push(bytes.slice());
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
      this.#socket.write(chunk, (error) => (error ? reject(error) : resolve()));
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

class EgressProxyTarget extends RpcTarget implements EgressHttpsProxy, Disposable {
  readonly observations: ProxyObservation[] = [];
  readonly #sockets = new Set<net.Socket>();

  async dial({ host, port }: { host: string; port: number }): Promise<EgressHttpsProxyConnection> {
    const socket = net.connect({ host, port });
    this.#sockets.add(socket);
    socket.once("close", () => this.#sockets.delete(socket));
    const observation: ProxyObservation = {
      bytesTargetToWorker: 0,
      bytesWorkerToTarget: 0,
      firstWorkerToTarget: new Uint8Array(),
      host,
      port,
      targetToWorkerChunks: [],
      workerToTargetChunks: [],
    };
    this.observations.push(observation);
    return new EgressProxyConnectionTarget({ observation, socket });
  }

  [Symbol.dispose](): void {
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
  }
}

// A throwaway HTTPS echo server with a self-signed cert. The worker pins that
// cert (so no skip-verify is needed) and terminates TLS itself over the proxy.
async function startHttpsEchoTarget(): Promise<{
  certSha256: string;
  close(): Promise<void>;
  requests: Array<{ body: string; proof: string | undefined; url: string | undefined }>;
  url: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), "itx-egress-proxy-"));
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
  const server = https.createServer(
    { cert: readFileSync(certPath), key: readFileSync(keyPath) },
    (req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const proof = req.headers[EGRESS_PROOF_HEADER];
        const record = {
          body,
          proof: Array.isArray(proof) ? proof.join(", ") : proof,
          url: req.url,
        };
        requests.push(record);
        const payload = JSON.stringify(record);
        res.setHeader("content-type", "application/json");
        res.setHeader("connection", "close");
        res.setHeader("content-length", String(Buffer.byteLength(payload)));
        res.end(payload);
      });
    },
  );
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        certSha256,
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

async function waitForCondition(
  predicate: () => Promise<boolean>,
  opts: { description: string; timeoutMs?: number },
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${opts.description}`);
}

describe("os itx egress proxy", () => {
  test("useEgressHttpsProxy relays secret-backed HTTPS as ciphertext only", async () => {
    const target = await startHttpsEchoTarget();
    using proxy = new EgressProxyTarget();
    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });

    try {
      using project = itx.projects.create({
        slug: `egress-proxy-${crypto.randomUUID().slice(0, 8)}`,
      });
      const secretPath = `/secrets/egress-proxy/${crypto.randomUUID()}`;
      using secret = project.secrets.get(secretPath);
      await secret.update({
        egress: { urls: [target.url] },
        material: "proxy-secret-material",
      });
      await waitForCondition(async () => (await secret.describe()).hasMaterial, {
        description: "egress proxy secret material",
      });

      using handle = await project.egress.useEgressHttpsProxy(proxy);

      const response = await project.egress.fetch(
        new Request(`${target.url}/secret-path?token=worker-only`, {
          body: "payload hidden from proxy",
          headers: {
            [EGRESS_PROXY_PINNED_CERT_SHA256_HEADER]: target.certSha256,
            [EGRESS_PROOF_HEADER]: `Bearer getSecret({ path: "${secretPath}" })`,
          },
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);

      // The worker substituted the secret and the target saw the real material.
      await expect(response.json()).resolves.toEqual({
        body: "payload hidden from proxy",
        proof: "Bearer proxy-secret-material",
        url: "/secret-path?token=worker-only",
      });
      expect(target.requests).toEqual([
        {
          body: "payload hidden from proxy",
          proof: "Bearer proxy-secret-material",
          url: "/secret-path?token=worker-only",
        },
      ]);

      // The proxy only ever moved TLS records: its transcript starts with the
      // TLS handshake byte (0x16) and contains none of the plaintext.
      const [observation] = proxy.observations;
      expect(observation).toMatchObject({
        host: "localhost",
        port: Number(new URL(target.url).port),
      });
      expect(observation!.firstWorkerToTarget[0]).toBe(0x16);
      const transcript = Buffer.from(
        concat([...observation!.workerToTargetChunks, ...observation!.targetToWorkerChunks]),
      ).toString("latin1");
      for (const secretString of [
        "proxy-secret-material",
        "payload hidden from proxy",
        "/secret-path",
        "worker-only",
      ]) {
        expect(transcript).not.toContain(secretString);
      }

      await waitForCondition(async () => (await secret.describe()).audit.usedCount === 1, {
        description: "egress proxy secret usage audit",
      });
      await handle.release();
    } finally {
      await target.close();
    }
  });
});

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
