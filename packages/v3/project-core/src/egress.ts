import { z } from "zod";
import { Fault } from "./model.ts";
import { canonical, type EventInput, type EventRecord } from "./signatures.ts";
import { base64Url as encode } from "./encoding.ts";

const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const REFERENCE = /^\{\{secret:([A-Z][A-Z0-9_]*)\}\}$/;
const RETRY_HEADER = "x-project-core-approval";
const MAX_BODY = 1_048_576;

const PutSecret = z.strictObject({
  name: z.string().regex(NAME),
  value: z.string().min(1).max(65_536),
  origin: z.string().max(2_048),
});
export const EgressPolicy = z.discriminatedUnion("approval", [
  z.strictObject({ approval: z.literal("none") }),
  z.strictObject({
    approval: z.literal("required"),
    expiresInMs: z.number().int().min(1_000).max(86_400_000),
  }),
]);
const Decision = z.strictObject({
  requestId: z.uuid(),
  fingerprint: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  allow: z.boolean(),
});

export type EgressPolicy = z.infer<typeof EgressPolicy>;
export type SecretReceipt = { name: string; origin: string; revision: number };
/** Must synchronously append inside the caller's current Durable Object transaction. */
export type PlatformAppend = (input: EventInput) => void;
export type EgressApplication = (record: EventRecord) => void;

type Secret = SecretReceipt & { nonce: string; ciphertext: string };
type Plan = {
  policyOffset: number;
  url: string;
  method: string;
  headers: [string, string][];
  body: Uint8Array;
  bodyHash: string;
  secrets: { header: string; name: string; revision: number }[];
  fingerprint: string;
};
type Gate = { allowed: boolean; audit: boolean; requestId: string; expiresAt: number };

/** The only owner of secret ciphertext and the one-shot external-effect gate. */
export class Egress {
  readonly #sql: SqlStorage;
  readonly #storage: DurableObjectStorage;
  #key: Promise<CryptoKey> | undefined;

  constructor(
    ctx: DurableObjectState,
    readonly context: string,
    readonly egressKey: string | undefined,
    readonly platformAppend: PlatformAppend,
    readonly afterAuditCommit: () => Promise<void>,
  ) {
    this.#storage = ctx.storage;
    this.#sql = ctx.storage.sql;
    this.#sql.exec(
      "CREATE TABLE IF NOT EXISTS egress_secrets (name TEXT PRIMARY KEY, origin TEXT NOT NULL, revision INTEGER NOT NULL, nonce TEXT NOT NULL, ciphertext TEXT NOT NULL)",
    );
    this.#sql.exec(
      "CREATE TABLE IF NOT EXISTS egress_pending (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, expires_at INTEGER NOT NULL, approval_offset INTEGER, approval_allow INTEGER, used_at INTEGER)",
    );
  }

  /** Call only from the authenticated control plane; no Scope or worker receives this method. */
  async putSecret(value: unknown): Promise<SecretReceipt> {
    const input = PutSecret.parse(value);
    const origin = secureOrigin(input.origin);
    const prior = this.#secret(input.name);
    const expectedRevision = prior?.revision ?? 0;
    const receipt: SecretReceipt = { name: input.name, origin, revision: expectedRevision + 1 };
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad(this.context, receipt) },
      await this.#cryptoKey(),
      bytes(input.value),
    );
    this.#storage.transactionSync(() => {
      if ((this.#secret(input.name)?.revision ?? 0) !== expectedRevision) {
        throw new Fault(
          "SECRET_CONFLICT",
          "Secret changed while this update was being encrypted",
          409,
        );
      }
      this.#sql.exec(
        "INSERT INTO egress_secrets VALUES (?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET origin=excluded.origin,revision=excluded.revision,nonce=excluded.nonce,ciphertext=excluded.ciphertext",
        receipt.name,
        receipt.origin,
        receipt.revision,
        encode(nonce),
        encode(new Uint8Array(ciphertext)),
      );
      this.#audit("itx.system.secret.put", receipt);
    });
    await this.afterAuditCommit();
    return receipt;
  }

  /** Policy choice is explicit; the synchronous guard belongs to the owning Context. */
  async terminal(
    request: Request,
    policy: unknown,
    policyOffset: number,
    assertCurrent: () => void,
  ): Promise<Response> {
    const parsed = EgressPolicy.parse(policy);
    const retry = request.headers.get(RETRY_HEADER);
    const plan = await this.#plan(request, policyOffset);
    const headers = await this.#inject(plan);
    assertCurrent();
    const audit = auditData(plan);
    if (parsed.approval === "required") {
      const gate = this.#gate(retry, plan, Date.now() + parsed.expiresInMs);
      if (!gate.allowed) {
        if (gate.audit) await this.afterAuditCommit();
        return new Response(
          JSON.stringify({
            code: "APPROVAL_REQUIRED",
            requestId: gate.requestId,
            fingerprint: plan.fingerprint,
            expiresAt: gate.expiresAt,
          }),
          { status: 202, headers: { "content-type": "application/json" } },
        );
      }
    } else {
      this.#storage.transactionSync(() => this.#audit("itx.system.egress.released", audit));
    }
    // No await between freshness, claim and dispatch. The DO output gate persists the claim
    // before sending; "released" records this one-shot attempt, never remote completion.
    const effect = fetch(
      new Request(plan.url, {
        method: plan.method,
        headers,
        body: plan.body.byteLength ? plan.body : undefined,
        redirect: "manual",
      }),
    );
    const [response] = await Promise.all([effect, this.afterAuditCommit()]);
    return response;
  }

  /** Root combines this with its prepared append application, then invokes it inside Stream's commit transaction. */
  prepare(input: EventInput): EgressApplication | undefined {
    if (input.type !== "approval.decided") return undefined;
    const decision = Decision.parse(input.data);
    return (record) => this.#applyApproval(record, decision);
  }

  #applyApproval(record: EventRecord, decision: z.infer<typeof Decision>) {
    if (record.verification.level !== 2) {
      throw new Fault("APPROVAL_SIGNER", "Approval requires a currently trusted signer", 403);
    }
    const pending = this.#sql
      .exec<{
        expires_at: number;
        approval_offset: number | null;
        used_at: number | null;
      }>(
        "SELECT expires_at,approval_offset,used_at FROM egress_pending WHERE request_id = ? AND fingerprint = ?",
        decision.requestId,
        decision.fingerprint,
      )
      .toArray()[0];
    if (!pending)
      throw new Fault("APPROVAL_REQUEST", "Approval names no pending exact request", 404);
    if (pending.expires_at < Date.now())
      throw new Fault("APPROVAL_EXPIRED", "Approval request expired", 409);
    if (pending.used_at !== null)
      throw new Fault("APPROVAL_USED", "Approval request was already consumed", 409);
    if (pending.approval_offset !== null)
      throw new Fault("APPROVAL_DECIDED", "Approval request was already decided", 409);
    const result = this.#sql.exec(
      "UPDATE egress_pending SET approval_offset = ?, approval_allow = ? WHERE request_id = ? AND approval_offset IS NULL",
      record.offset,
      Number(decision.allow),
      decision.requestId,
    );
    if (result.rowsWritten !== 1)
      throw new Fault("APPROVAL_RACE", "Approval request changed during commit", 409);
  }

  #gate(retry: string | null, plan: Plan, expiresAt: number): Gate {
    return this.#storage.transactionSync(() => {
      if (!retry) {
        const requestId = crypto.randomUUID();
        this.#sql.exec(
          "INSERT INTO egress_pending(request_id,fingerprint,expires_at) VALUES (?,?,?)",
          requestId,
          plan.fingerprint,
          expiresAt,
        );
        this.#audit("itx.system.egress.requested", { requestId, ...auditData(plan), expiresAt });
        return { allowed: false, audit: true, requestId, expiresAt };
      }
      const pending = this.#sql
        .exec<{
          expires_at: number;
          approval_offset: number | null;
          approval_allow: number | null;
          used_at: number | null;
        }>(
          "SELECT expires_at,approval_offset,approval_allow,used_at FROM egress_pending WHERE request_id = ? AND fingerprint = ?",
          retry,
          plan.fingerprint,
        )
        .toArray()[0];
      if (!pending)
        throw new Fault("APPROVAL_MISMATCH", "Approval does not bind this exact request", 409);
      if (pending.used_at !== null)
        throw new Fault("APPROVAL_USED", "Approval was already consumed", 409);
      if (pending.expires_at < Date.now())
        throw new Fault("APPROVAL_EXPIRED", "Approval expired", 409);
      if (pending.approval_offset === null)
        return { allowed: false, audit: false, requestId: retry, expiresAt: pending.expires_at };
      if (!pending.approval_allow)
        throw new Fault("APPROVAL_DENIED", "Approval explicitly denied this request", 403);
      const result = this.#sql.exec(
        "UPDATE egress_pending SET used_at = ? WHERE request_id = ? AND used_at IS NULL",
        Date.now(),
        retry,
      );
      if (result.rowsWritten !== 1)
        throw new Fault("APPROVAL_RACE", "Approval request changed during use", 409);
      this.#audit("itx.system.egress.released", auditData(plan));
      return { allowed: true, audit: true, requestId: retry, expiresAt: pending.expires_at };
    });
  }

  async #plan(request: Request, policyOffset: number): Promise<Plan> {
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.username || url.password || url.href.length > 8_192) {
      throw new Fault("EGRESS_URL", "Egress requires a bounded HTTPS URL");
    }
    url.hash = "";
    const headers = [...new Headers(request.headers).entries()].filter(
      ([name]) => name !== RETRY_HEADER,
    );
    const body = await readBody(request);
    const secrets = headers.flatMap(([header, value]) => {
      const match = REFERENCE.exec(value);
      if (!match) {
        if (value.includes("{{secret:"))
          throw new Fault(
            "SECRET_REFERENCE",
            "Secret references must occupy an entire header value",
          );
        return [];
      }
      const secret = this.#secret(match[1]);
      if (!secret || secret.origin !== url.origin)
        throw new Fault("SECRET_ORIGIN", "Secret is unavailable for this origin", 403);
      return [{ header, name: secret.name, revision: secret.revision }];
    });
    const bodyHash = await hash(body);
    const fingerprint = await hash(
      bytes(
        canonical({
          policyOffset,
          method: request.method.toUpperCase(),
          url: url.href,
          headers,
          bodyHash,
          secrets,
        }),
      ),
    );
    return {
      policyOffset,
      url: url.href,
      method: request.method.toUpperCase(),
      headers,
      body,
      bodyHash,
      secrets,
      fingerprint,
    };
  }

  async #inject(plan: Plan) {
    const headers = new Headers(plan.headers);
    for (const secret of plan.secrets) {
      const row = this.#secret(secret.name);
      if (!row || row.revision !== secret.revision)
        throw new Fault(
          "SECRET_CHANGED",
          "Secret changed between request planning and injection",
          409,
        );
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: decode(row.nonce), additionalData: aad(this.context, row) },
        await this.#cryptoKey(),
        decode(row.ciphertext),
      );
      headers.set(secret.header, new TextDecoder().decode(plaintext));
    }
    return headers;
  }

  #secret(name: string): Secret | undefined {
    return this.#sql
      .exec<Secret>(
        "SELECT name,origin,revision,nonce,ciphertext FROM egress_secrets WHERE name = ?",
        name,
      )
      .toArray()[0];
  }

  #audit(type: string, data: EventInput["data"]) {
    this.platformAppend({ id: crypto.randomUUID(), type, data });
  }

  #cryptoKey() {
    return (this.#key ??= importKey(this.egressKey));
  }
}

function auditData(plan: Plan) {
  return {
    policyOffset: plan.policyOffset,
    fingerprint: plan.fingerprint,
    method: plan.method,
    origin: new URL(plan.url).origin,
    bodyHash: plan.bodyHash,
    secrets: plan.secrets,
  };
}

function aad(context: string, receipt: SecretReceipt) {
  return bytes(
    canonical({
      domain: "iterate.egress.secret.v1",
      context,
      name: receipt.name,
      origin: receipt.origin,
      revision: receipt.revision,
    }),
  );
}

async function readBody(request: Request) {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY)
    throw new Fault("EGRESS_BODY", "Egress request body exceeds 1 MiB", 413);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = request.clone().body?.getReader();
  } catch {
    throw new Fault("EGRESS_BODY", "Egress request body is unavailable");
  }
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel();
        throw new Fault("EGRESS_BODY", "Egress request body exceeds 1 MiB", 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Fault) throw error;
    throw new Fault("EGRESS_BODY", "Egress request body could not be read");
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function secureOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Fault("SECRET_ORIGIN", "Secret origin must be a bare HTTPS origin");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Fault("SECRET_ORIGIN", "Secret origin must be a bare HTTPS origin");
  }
  return url.origin;
}

function bytes(value: string) {
  return new TextEncoder().encode(value);
}

function decode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1)
    throw new Fault("EGRESS_KEY", "Invalid base64url key");
  const padded =
    value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    throw new Fault("EGRESS_KEY", "Invalid base64url key");
  }
}

async function hash(value: Uint8Array) {
  return encode(new Uint8Array(await crypto.subtle.digest("SHA-256", value)));
}

async function importKey(value: string | undefined) {
  if (!value) throw new Fault("EGRESS_KEY", "EGRESS_KEY is required to use secrets", 503);
  const raw = decode(value);
  if (raw.byteLength !== 32)
    throw new Fault("EGRESS_KEY", "EGRESS_KEY must encode exactly 32 bytes");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
