// project-host.ts — reach the worker AS a project host (`<app>--<project>.<base>`, the one HTTP way
// into a project). Node's fetch and WebSocket refuse a Host override and `*.localhost` does not
// resolve on macOS, so against the local worker this speaks raw node:http with the Host header set —
// the WebSocket upgrade included, one frame each way; against a deployed worker the wildcard DNS is
// real and plain fetch / WebSocket do — one test runs both ways.
import http from "node:http";
import { join } from "node:path";
import { test } from "vitest";
import { experimental_readRawConfig } from "wrangler";
import { adminCredentials, session, workerUrl } from "./client.ts";
import { PACKAGE_DIR } from "./worker-config.ts";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);
const worker = (): URL => new URL(workerUrl("/"));
/** Is the worker under test the LOCAL one global-setup booted (its project hosts hang under
 *  `localhost`)? The deployed proof sets WORKER_BASE_URL to a real hostname. */
export const projectHostsAreLocal = (): boolean => LOCAL_HOSTNAMES.has(worker().hostname);
/** `test`, skipped against the local worker — for what only a real deployment can prove (Artifacts,
 *  the real AI binding, a Host-carrying WebSocket upgrade). The ONE gate; never copy the regex. */
export const deployedOnly = test.skipIf(projectHostsAreLocal());

/** The base project hosts hang under: `localhost` for the local worker (worker-config.ts), the
 *  deployed worker's `APP_CONFIG_PROJECT_HOSTNAME_BASE` (wrangler.jsonc) otherwise. */
export function projectHostnameBase(): string {
  if (projectHostsAreLocal()) return "localhost";
  const { rawConfig } = experimental_readRawConfig({ config: join(PACKAGE_DIR, "wrangler.jsonc") });
  return String((rawConfig.vars as Record<string, unknown>).APP_CONFIG_PROJECT_HOSTNAME_BASE);
}

/** Register `projectId` with the directory — `projects.create({ project })` over the worker's own
 *  /api, on the admin session (the project lands in the deployment's own org) or as `as` (a user's
 *  session: their org, with them a member) — so its host serves. A project's id IS its slug (a DNS
 *  label), so one name addresses both the DO (`openItx(projectId)`) and the host
 *  (`site--<projectId>.<base>`). Idempotent; identical against the local and the deployed worker. */
export async function registerProject(projectId: string, as?: { email: string }): Promise<void> {
  await session().authenticate(adminCredentials(as)).projects.create({ project: projectId });
}

/** A project id that is a DNS label — the convention needs one (`freshCtx` names carry `_`). */
let counter = 0;
export const freshDnsSafeProjectId = (prefix: string): string =>
  `prj-${prefix}-${Date.now().toString(36)}-${counter++}`;

/** `path` on `host` — a GET, or `init`'s method and body: with the Host header against the local
 *  worker, over the real wildcard DNS against a deployed one. */
export async function fetchProjectHost(
  host: string,
  path: string,
  headers: Record<string, string> = {},
  init: { method?: string; body?: string } = {},
): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  const target = worker();
  const { method = "GET", body } = init;
  if (!projectHostsAreLocal()) {
    const res = await fetch(`${target.protocol}//${host}${path}`, {
      method,
      headers,
      body,
      redirect: "manual",
    });
    return { status: res.status, headers: Object.fromEntries(res.headers), text: await res.text() };
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: target.hostname,
        port: target.port,
        path,
        method,
        headers: {
          ...headers,
          host,
          ...(body !== undefined && { "content-length": String(Buffer.byteLength(body)) }),
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: Object.fromEntries(
              Object.entries(res.headers).map(([name, value]) => [name, String(value)]),
            ),
            text: body,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** What one eyeball WebSocket round trip saw: `opened` (the 101), the first message, the close code. */
export type WebSocketRoundTrip = {
  opened: boolean;
  echo?: string;
  closeCode?: number;
  error?: string;
};

/** One full eyeball WebSocket round trip on a project host — open → send → first message → close
 *  (1000). Never throws — the caller asserts on the outcome. Over the real wildcard DNS against a
 *  deployed worker; against the local worker the upgrade rides raw node:http with the Host header
 *  (`rawWebSocketRoundTrip`). */
export function wsRoundTripOnProjectHost(
  host: string,
  path: string,
  send: string,
  timeoutMs = 10_000,
): Promise<WebSocketRoundTrip> {
  if (projectHostsAreLocal()) return rawWebSocketRoundTrip(host, path, send, timeoutMs);
  return new Promise((resolve) => {
    const out: WebSocketRoundTrip = { opened: false };
    const ws = new WebSocket(`wss://${host}${path}`);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve({ ...out, error: out.error ?? `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    ws.addEventListener("open", () => {
      out.opened = true;
      ws.send(send);
    });
    ws.addEventListener("message", (ev) => {
      out.echo = String((ev as MessageEvent).data);
      ws.close(1000, "done");
    });
    ws.addEventListener("error", (ev) => {
      out.error = String((ev as { message?: unknown }).message ?? "websocket error");
    });
    ws.addEventListener("close", (ev) => {
      clearTimeout(timer);
      out.closeCode = (ev as CloseEvent).code;
      resolve(out);
    });
  });
}

/** The same round trip spoken raw to the local worker: an HTTP/1.1 upgrade with the Host header,
 *  one masked text frame out, the first text frame in, a masked close (1000) and the close that
 *  answers it. RFC 6455's client half for payloads under 126 bytes — all a round trip needs. */
function rawWebSocketRoundTrip(
  host: string,
  path: string,
  send: string,
  timeoutMs: number,
): Promise<WebSocketRoundTrip> {
  const target = worker();
  return new Promise((resolve) => {
    const out: WebSocketRoundTrip = { opened: false };
    const timer = setTimeout(
      () => resolve({ ...out, error: out.error ?? `timeout after ${timeoutMs}ms` }),
      timeoutMs,
    );
    const done = () => {
      clearTimeout(timer);
      resolve(out);
    };
    const req = http.request({
      host: target.hostname,
      port: target.port,
      path,
      headers: {
        host,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": btoa(
          String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))),
        ),
      },
    });
    req.on("response", (res) => {
      out.error = `no 101: ${res.statusCode}`;
      res.resume();
      done();
    });
    req.on("error", (error) => {
      out.error = error.message;
      done();
    });
    req.on("upgrade", (_res, socket) => {
      out.opened = true;
      socket.write(clientFrame(0x1, new TextEncoder().encode(send)));
      let buffered: Uint8Array = new Uint8Array(0);
      socket.on("data", (chunk: Uint8Array) => {
        buffered = concatBytes(buffered, chunk);
        for (let frame = serverFrame(buffered); frame; frame = serverFrame(buffered)) {
          buffered = buffered.subarray(frame.length);
          if (frame.opcode === 0x1) {
            out.echo = new TextDecoder().decode(frame.payload);
            socket.write(clientFrame(0x8, new Uint8Array([0x03, 0xe8]))); // close 1000
          } else if (frame.opcode === 0x8) {
            out.closeCode =
              frame.payload.length >= 2 ? (frame.payload[0]! << 8) | frame.payload[1]! : undefined;
            socket.end();
          }
        }
      });
      socket.on("close", done);
      socket.on("error", (error) => {
        out.error = error.message;
        done();
      });
    });
    req.end();
  });
}

const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

/** A masked client frame (FIN set; a payload under 126 bytes). */
function clientFrame(opcode: number, payload: Uint8Array): Uint8Array {
  const mask = crypto.getRandomValues(new Uint8Array(4));
  const frame = new Uint8Array(6 + payload.length);
  frame.set([0x80 | opcode, 0x80 | payload.length, ...mask]);
  for (let i = 0; i < payload.length; i++) frame[6 + i] = payload[i]! ^ mask[i % 4]!;
  return frame;
}

/** The first complete (unmasked) server frame at the head of `buffer`, or null while it is partial. */
function serverFrame(
  buffer: Uint8Array,
): { opcode: number; payload: Uint8Array; length: number } | null {
  if (buffer.length < 2) return null;
  const opcode = buffer[0]! & 0x0f;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = (buffer[2]! << 8) | buffer[3]!;
    offset = 4;
  }
  if (buffer.length < offset + length) return null;
  return { opcode, payload: buffer.subarray(offset, offset + length), length: offset + length };
}
