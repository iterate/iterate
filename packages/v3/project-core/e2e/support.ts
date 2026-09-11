import assert from "node:assert/strict";
import { webcrypto, type webcrypto as WebCrypto } from "node:crypto";
import { newWebSocketRpcSession, type RpcTarget } from "capnweb";
import { WebSocket as ClientSocket } from "undici";

export const base = process.env.WORKER_BASE_URL?.replace(/\/$/, "");
export const timeout = 30_000;
export const browserHeaders = { cookie: "", origin: base ?? "" };
if (base) {
  const login = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { origin: base },
    body: new URLSearchParams({ email: "e2e@example.com" }),
    signal: AbortSignal.timeout(timeout),
  });
  assert.equal(login.status, 303, "public demo login must succeed");
  browserHeaders.cookie = login.headers.get("set-cookie")!.split(";")[0];
}
export function socket(url: string): WebSocket {
  // Undici supplies the browser WebSocket surface Cap'n Web uses, plus handshake headers for Node.
  return new ClientSocket(url, { headers: browserHeaders }) as unknown as WebSocket;
}
export function session<T extends RpcTarget>(projectId: string, path = "/") {
  const url = new URL("/rpc", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("project", projectId);
  url.searchParams.set("path", path);
  return newWebSocketRpcSession<T>(socket(url.href));
}
export const crypto = webcrypto;
export type KeyPair = { publicKey: WebCrypto.CryptoKey; privateKey: WebCrypto.CryptoKey };
export type Jwk = WebCrypto.JsonWebKey;
export type PublicEvent<Data = unknown> = {
  id: string;
  type: string;
  data: Data;
  provenance?: { parents: string[]; producer?: string; signatures: { key: Jwk; value: string }[] };
};

/** The ordinary settings event; tests retain each id, key, and value at the call site. */
export function setting<Value>(id: string, key: string, value: Value) {
  return { id, type: "itx.set", data: { key, value } };
}

export function project(prefix = "project-core-e2e") {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Poll a completed observation; exceptions from `check` remain test failures. */
export async function eventually(
  check: () => Promise<boolean>,
  message: string,
  deadlineMs = timeout,
  diagnostic?: () => Promise<string>,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`${message}${diagnostic ? `; ${await diagnostic()}` : ""}`);
}

export async function api(projectId: string, method: string[], args: unknown[], path = "/") {
  const url = new URL("/api", base);
  url.searchParams.set("project", projectId);
  url.searchParams.set("path", path);
  const response = await fetch(url, {
    method: "POST",
    headers: { ...browserHeaders, "content-type": "application/json" },
    body: JSON.stringify({ method, args }),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as unknown, text };
}

export async function call(
  projectId: string,
  method: string[],
  args: unknown[],
  expectedStatus = 200,
  path = "/",
): Promise<unknown> {
  const { status, body, text } = await api(projectId, method, args, path);
  assert.equal(status, expectedStatus, text);
  assert.ok(body && typeof body === "object");
  if (expectedStatus === 200) {
    assert.ok("result" in body, text);
    return body.result;
  }
  assert.ok("error" in body, text);
  const error = body.error;
  assert.ok(error && typeof error === "object");
  assert.ok("code" in error && "message" in error);
  assert.equal(typeof error.code, "string");
  assert.equal(typeof error.message, "string");
  return error;
}

/** Canonical public event-envelope bytes, deliberately independent of the Worker implementation. */
export function canonical(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  assert.ok(value && typeof value === "object");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function base64Url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64url");
}

export async function keyPair(): Promise<KeyPair> {
  const generated = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  if (!("publicKey" in generated && "privateKey" in generated))
    throw new Error("Ed25519 key pair required");
  // Node types overload generateKey as either a key or pair; this algorithm always returns the checked pair.
  return generated as KeyPair;
}

export async function keyId(key: Jwk) {
  assert.ok(key.kty === "OKP" && key.crv === "Ed25519" && typeof key.x === "string");
  const bytes = new TextEncoder().encode(canonical({ crv: key.crv, kty: key.kty, x: key.x }));
  return `ed25519:${base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))}`;
}

export async function sign(context: string, event: PublicEvent, pair: KeyPair) {
  const key = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const bytes = new TextEncoder().encode(
    canonical({
      context,
      data: event.data,
      domain: "iterate.event.v1",
      id: event.id,
      type: event.type,
      provenance: {
        parents: event.provenance?.parents ?? [],
        ...(event.provenance?.producer && { producer: event.provenance.producer }),
      },
    }),
  );
  return {
    key,
    value: base64Url(new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, bytes))),
  };
}
