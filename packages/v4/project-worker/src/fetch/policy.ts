// fetch/policy.ts — encrypted direct egress secrets and the one-shot approval gate.  This layer
// deliberately sits after the legacy project/platform substitution doors: it only owns the new
// exact-header `{{secret:NAME}}` syntax and never sees plaintext in a stream event or receipt.

import { z } from "zod";
import { codedError } from "../lib/errors.ts";
import type { StreamEvent, StreamEventInput } from "../stream/events.ts";
import type { StreamCommitParticipant } from "../stream/stream.ts";

const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const DIRECT_REFERENCE = /^\{\{secret:([A-Z][A-Z0-9_]*)\}\}$/;
const ANY_DIRECT_REFERENCE = /\{\{secret:[A-Z][A-Z0-9_]*\}\}/;
const APPROVAL_HEADER = "x-iterate-approval";
const MAX_BODY = 1_048_576;
export const EGRESS_POLICY_CONFIGURED = "events.iterate.com/egress/policy-configured";
export const APPROVAL_DECIDED = "events.iterate.com/approval/decided";
const SecretInput = z.strictObject({
  name: z.string().regex(SECRET_NAME),
  value: z.string().min(1).max(65_536),
  origin: z.string().max(2_048),
});
const PolicyInput = z.discriminatedUnion("approval", [
  z.strictObject({ approval: z.literal("none") }),
  z.strictObject({
    approval: z.literal("required"),
    expiresInMs: z.number().int().min(1_000).max(86_400_000),
  }),
]);
const ApprovalDecision = z.strictObject({
  requestId: z.string().uuid(),
  fingerprint: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  allow: z.boolean(),
});

export type EgressPolicy = { approval: "none" } | { approval: "required"; expiresInMs: number };
export type SecretReceipt = { name: string; origin: string; revision: number };
export type PolicyReceipt = EgressPolicy & { revision: number };
export type ApprovalReceipt = {
  requestId: string;
  expiresAt: number;
  origin: string;
  method: string;
  policyRevision: number;
  decidedAtOffset: number | null;
  allow: boolean | null;
  used: boolean;
};
type Secret = SecretReceipt & { nonce: string; ciphertext: string };
type Prepared = {
  url: string;
  method: string;
  headers: [string, string][];
  body: Uint8Array;
  bodyHash: string;
  policy: PolicyReceipt;
  secrets: { header: string; name: string; revision: number }[];
  hostPolicy: string;
  fingerprint: string;
};

export type EgressPolicyOptions = {
  storage: { sql: SqlStorage; transactionSync<T>(callback: () => T): T };
  context: string;
  egressKey: string | undefined;
  /** Appends a safe, plaintext-free audit fact inside the current DO transaction. */
  appendAudit: (event: StreamEventInput) => void;
  /** Authorization remains a host concern; provenance verification alone never grants it. */
  isTrustedApproval: (event: StreamEvent) => boolean;
  /** Binds a request to host-owned rewrite/policy state as well as this layer's revision. */
  policyFingerprint?: () => string;
};

/** Owns ciphertext, policy state, and the approval claim. It does not own HTTP authentication or
 * separate policy-writer authority: `egress/policy-configured` is an ordinary durable fact, so the
 * context's global provenance policy decides who may append it. At minimumLevel 0 a full ITX writer
 * may replace the gate; an approval token only binds one pending dispatch, never a policy writer. */
export class FetchPolicy implements StreamCommitParticipant {
  readonly #sql: SqlStorage;
  #key: Promise<CryptoKey> | undefined;

  constructor(readonly options: EgressPolicyOptions) {
    this.#sql = options.storage.sql;
    this.#sql.exec(
      "CREATE TABLE IF NOT EXISTS egress_secrets (name TEXT PRIMARY KEY, origin TEXT NOT NULL, revision INTEGER NOT NULL, nonce TEXT NOT NULL, ciphertext TEXT NOT NULL)",
    );
    this.#sql.exec(
      "CREATE TABLE IF NOT EXISTS egress_policy (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL, approval TEXT NOT NULL, expires_in_ms INTEGER)",
    );
    this.#sql.exec(
      "CREATE TABLE IF NOT EXISTS egress_pending (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, expires_at INTEGER NOT NULL, approval_offset INTEGER, approval_allow INTEGER, used_at INTEGER, origin TEXT NOT NULL, method TEXT NOT NULL, policy_revision INTEGER NOT NULL)",
    );
    this.#sql.exec("INSERT OR IGNORE INTO egress_policy VALUES (1, 0, 'none', NULL)");
  }

  /** Control-plane only.  Do not put this method on ITX or a loaded worker capability. */
  async putSecret(input: unknown): Promise<SecretReceipt> {
    const value = parse(SecretInput, input, "SECRET_INPUT", "Invalid secret input");
    const origin = secureOrigin(value.origin);
    const prior = this.#secret(value.name);
    const receipt = { name: value.name, origin, revision: (prior?.revision ?? 0) + 1 };
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad(this.options.context, receipt) },
      await this.#cryptoKey(),
      utf8(value.value),
    );
    this.options.storage.transactionSync(() => {
      if ((this.#secret(value.name)?.revision ?? 0) !== receipt.revision - 1)
        throw codedError("SECRET_CONFLICT", "Secret changed while this update was being encrypted");
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
    return receipt;
  }

  listSecrets(): SecretReceipt[] {
    return this.#sql
      .exec<SecretReceipt>("SELECT name,origin,revision FROM egress_secrets ORDER BY name")
      .toArray();
  }

  /** Safe status only: never return ciphertext, plaintext, body content, or request headers. */
  listApprovalReceipts(): ApprovalReceipt[] {
    return this.#sql
      .exec<{
        request_id: string;
        expires_at: number;
        origin: string;
        method: string;
        policy_revision: number;
        approval_offset: number | null;
        approval_allow: number | null;
        used_at: number | null;
      }>(
        "SELECT request_id,expires_at,origin,method,policy_revision,approval_offset,approval_allow,used_at FROM egress_pending ORDER BY expires_at DESC",
      )
      .toArray()
      .map((row) => ({
        requestId: row.request_id,
        expiresAt: row.expires_at,
        origin: row.origin,
        method: row.method,
        policyRevision: row.policy_revision,
        decidedAtOffset: row.approval_offset,
        allow: row.approval_allow === null ? null : Boolean(row.approval_allow),
        used: row.used_at !== null,
      }));
  }

  /** Validate policy/approval facts before Stream assigns offsets; `apply` still owns the SQL write. */
  prepare(...events: StreamEventInput[]): StreamEventInput[] {
    for (const event of events) {
      if (event.type === EGRESS_POLICY_CONFIGURED) {
        if (event.ephemeral)
          throw codedError("POLICY_INPUT", "Egress policy facts must be durable");
        parsePolicy(event.payload);
      }
      if (event.type === APPROVAL_DECIDED) {
        if (event.ephemeral)
          throw codedError("APPROVAL_INPUT", "Approval decisions must be durable");
        parseDecision(event.payload);
      }
    }
    return events;
  }

  /** The final egress door.  `terminal` is normally the platform fallback service binding. */
  async fetch(
    request: Request,
    terminal: (request: Request) => Promise<Response>,
  ): Promise<Response> {
    const policy = this.#policy();
    const hostPolicy = this.options.policyFingerprint?.() ?? "";
    const direct = this.#directReferences(request);
    const retry = request.headers.get(APPROVAL_HEADER);
    // Preserve the legacy door exactly: streaming bodies and WebSocket upgrades remain untouched.
    if (policy.approval === "none" && direct.length === 0 && !retry) return terminal(request);
    const plan = await this.#plan(request, policy, hostPolicy, direct);
    const headers = await this.#inject(plan);
    // No await follows this recheck until the output gate has durably claimed the approval.
    this.#assertCurrent(plan);
    // A retry token is an assertion about an approved policy revision, never a harmless header a
    // later `none` policy may silently turn into an unbound outbound effect.
    if (retry && plan.policy.approval === "none")
      throw codedError("APPROVAL_MISMATCH", "Approval does not bind the current egress policy");
    const gate =
      plan.policy.approval === "required" ? this.#gate(retry, plan) : this.#release(plan);
    if (!gate.allowed) {
      return Response.json(
        {
          code: "APPROVAL_REQUIRED",
          requestId: gate.requestId,
          fingerprint: plan.fingerprint,
          expiresAt: gate.expiresAt,
        },
        { status: 202 },
      );
    }
    return terminal(
      new Request(plan.url, {
        method: plan.method,
        headers,
        body: plan.body.byteLength ? plan.body : undefined,
        redirect: "manual",
      }),
    );
  }

  /** Stream's synchronous participant seam. */
  apply(event: StreamEvent): void {
    if (event.type === EGRESS_POLICY_CONFIGURED) {
      const next = parsePolicy(event.payload);
      this.#sql.exec(
        "UPDATE egress_policy SET revision = ?, approval = ?, expires_in_ms = ? WHERE singleton = 1",
        event.offset,
        next.approval,
        next.approval === "required" ? next.expiresInMs : null,
      );
      return;
    }
    if (event.type !== APPROVAL_DECIDED) return;
    if (!this.options.isTrustedApproval(event))
      throw codedError("APPROVAL_SIGNER", "Approval requires a currently trusted signer");
    const decision = parseDecision(event.payload);
    const pending = this.#sql
      .exec<{ expires_at: number; approval_offset: number | null; used_at: number | null }>(
        "SELECT expires_at,approval_offset,used_at FROM egress_pending WHERE request_id = ? AND fingerprint = ?",
        decision.requestId,
        decision.fingerprint,
      )
      .toArray()[0];
    if (!pending) throw codedError("APPROVAL_REQUEST", "Approval names no pending exact request");
    if (pending.expires_at < Date.now())
      throw codedError("APPROVAL_EXPIRED", "Approval request expired");
    if (pending.used_at !== null)
      throw codedError("APPROVAL_USED", "Approval request was already consumed");
    if (pending.approval_offset !== null)
      throw codedError("APPROVAL_DECIDED", "Approval request was already decided");
    const result = this.#sql.exec(
      "UPDATE egress_pending SET approval_offset = ?, approval_allow = ? WHERE request_id = ? AND approval_offset IS NULL",
      event.offset,
      Number(decision.allow),
      decision.requestId,
    );
    if (result.rowsWritten !== 1)
      throw codedError("APPROVAL_RACE", "Approval request changed during commit");
  }

  async #plan(
    request: Request,
    policy: PolicyReceipt,
    hostPolicy: string,
    secrets: { header: string; name: string; revision: number }[],
  ): Promise<Prepared> {
    const url = new URL(request.url);
    url.hash = "";
    const headers = [...new Headers(request.headers).entries()].filter(
      ([name]) => name !== APPROVAL_HEADER,
    );
    const body = await readBody(request);
    if (
      policy.approval === "required" &&
      (url.protocol !== "https:" || url.username || url.password || url.href.length > 8_192)
    )
      throw codedError("EGRESS_URL", "Approved egress requires a bounded HTTPS URL");
    const bodyHash = await hash(body);
    const fingerprint = await hash(
      utf8(
        canonical({
          policy,
          hostPolicy,
          method: request.method.toUpperCase(),
          url: url.href,
          headers,
          bodyHash,
          secrets,
        }),
      ),
    );
    return {
      url: url.href,
      method: request.method.toUpperCase(),
      headers,
      body,
      bodyHash,
      policy,
      secrets,
      hostPolicy,
      fingerprint,
    };
  }

  async #inject(plan: Prepared): Promise<Headers> {
    const headers = new Headers(plan.headers);
    for (const secret of plan.secrets) {
      const row = this.#secret(secret.name);
      if (!row || row.revision !== secret.revision)
        throw codedError("SECRET_CHANGED", "Secret changed between planning and injection");
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: decode(row.nonce), additionalData: aad(this.options.context, row) },
        await this.#cryptoKey(),
        decode(row.ciphertext),
      );
      headers.set(secret.header, new TextDecoder().decode(plain));
    }
    return headers;
  }

  #assertCurrent(plan: Prepared) {
    if (
      this.#policy().revision !== plan.policy.revision ||
      (this.options.policyFingerprint?.() ?? "") !== plan.hostPolicy
    )
      throw codedError(
        "POLICY_CHANGED",
        "Egress policy changed while the request was being prepared",
      );
    for (const secret of plan.secrets)
      if (this.#secret(secret.name)?.revision !== secret.revision)
        throw codedError("SECRET_CHANGED", "Secret changed while the request was being prepared");
  }

  #release(plan: Prepared) {
    this.options.storage.transactionSync(() =>
      this.#audit("itx.system.egress.released", audit(plan)),
    );
    return { allowed: true, requestId: "", expiresAt: 0 };
  }
  #gate(retry: string | null, plan: Prepared) {
    return this.options.storage.transactionSync(() => {
      if (!retry) {
        const requestId = crypto.randomUUID(),
          expiresAt = Date.now() + (plan.policy as { expiresInMs: number }).expiresInMs;
        this.#sql.exec(
          "INSERT INTO egress_pending(request_id,fingerprint,expires_at,origin,method,policy_revision) VALUES (?,?,?,?,?,?)",
          requestId,
          plan.fingerprint,
          expiresAt,
          new URL(plan.url).origin,
          plan.method,
          plan.policy.revision,
        );
        this.#audit("itx.system.egress.requested", { requestId, ...audit(plan), expiresAt });
        return { allowed: false, requestId, expiresAt };
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
        throw codedError("APPROVAL_MISMATCH", "Approval does not bind this exact request");
      if (pending.used_at !== null)
        throw codedError("APPROVAL_USED", "Approval was already consumed");
      if (pending.expires_at < Date.now()) throw codedError("APPROVAL_EXPIRED", "Approval expired");
      if (pending.approval_offset === null)
        return { allowed: false, requestId: retry, expiresAt: pending.expires_at };
      if (!pending.approval_allow)
        throw codedError("APPROVAL_DENIED", "Approval explicitly denied this request");
      if (
        this.#sql.exec(
          "UPDATE egress_pending SET used_at = ? WHERE request_id = ? AND used_at IS NULL",
          Date.now(),
          retry,
        ).rowsWritten !== 1
      )
        throw codedError("APPROVAL_RACE", "Approval request changed during use");
      this.#audit("itx.system.egress.released", audit(plan));
      return { allowed: true, requestId: retry, expiresAt: pending.expires_at };
    });
  }
  #policy(): PolicyReceipt {
    const row = this.#sql
      .exec<{ revision: number; approval: string; expires_in_ms: number | null }>(
        "SELECT revision,approval,expires_in_ms FROM egress_policy WHERE singleton = 1",
      )
      .toArray()[0]!;
    return row.approval === "required"
      ? { revision: row.revision, approval: "required", expiresInMs: row.expires_in_ms! }
      : { revision: row.revision, approval: "none" };
  }
  #secret(name: string): Secret | undefined {
    return this.#sql
      .exec<Secret>(
        "SELECT name,origin,revision,nonce,ciphertext FROM egress_secrets WHERE name = ?",
        name,
      )
      .toArray()[0];
  }
  /** Reject new-syntax URL/embedded values before they could leave the project; leave legacy scopes alone. */
  #directReferences(request: Request): { header: string; name: string; revision: number }[] {
    if (ANY_DIRECT_REFERENCE.test(request.url))
      throw codedError(
        "SECRET_REFERENCE",
        "Secret references are allowed only as an entire header value",
      );
    const url = new URL(request.url);
    return [...request.headers].flatMap(([header, value]) => {
      const match = DIRECT_REFERENCE.exec(value);
      if (!match) {
        if (ANY_DIRECT_REFERENCE.test(value))
          throw codedError(
            "SECRET_REFERENCE",
            "Secret references must occupy an entire header value",
          );
        return [];
      }
      const secret = this.#secret(match[1]!);
      if (!secret || secret.origin !== url.origin)
        throw codedError("SECRET_ORIGIN", "Secret is unavailable for this origin");
      return [{ header, name: secret.name, revision: secret.revision }];
    });
  }
  #audit(type: string, payload: Record<string, unknown>) {
    this.options.appendAudit({ type, payload, idempotencyKey: crypto.randomUUID() });
  }
  #cryptoKey() {
    return (this.#key ??= importKey(this.options.egressKey));
  }
}

function audit(plan: Prepared) {
  return {
    policyRevision: plan.policy.revision,
    fingerprint: plan.fingerprint,
    method: plan.method,
    origin: new URL(plan.url).origin,
    bodyHash: plan.bodyHash,
    secrets: plan.secrets,
  };
}
function parsePolicy(input: unknown): EgressPolicy {
  return parse(PolicyInput, input, "POLICY_INPUT", "Invalid egress policy");
}
function parseDecision(input: unknown) {
  return parse(ApprovalDecision, input, "APPROVAL_INPUT", "Invalid approval decision");
}
function parse<T>(
  schema: z.ZodType<T>,
  input: unknown,
  code: "SECRET_INPUT" | "POLICY_INPUT" | "APPROVAL_INPUT",
  message: string,
): T {
  const result = schema.safeParse(input);
  if (!result.success) throw codedError(code, message);
  return result.data;
}
function secureOrigin(value: string) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    throw codedError("SECRET_ORIGIN", "Secret origin must be a bare HTTPS origin");
  }
}
async function readBody(request: Request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY)
    throw codedError("EGRESS_BODY", "Egress request body exceeds 1 MiB");
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = request.clone().body?.getReader();
  } catch {
    throw codedError("EGRESS_BODY", "Egress request body could not be read");
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
        throw codedError("EGRESS_BODY", "Egress request body exceeds 1 MiB");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error) throw error;
    throw codedError("EGRESS_BODY", "Egress request body could not be read");
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
function aad(context: string, receipt: SecretReceipt) {
  return utf8(
    canonical({
      domain: "iterate.egress.secret.v1",
      context,
      name: receipt.name,
      origin: receipt.origin,
      revision: receipt.revision,
    }),
  );
}
function utf8(value: string) {
  return new TextEncoder().encode(value);
}
async function hash(value: Uint8Array) {
  return encode(new Uint8Array(await crypto.subtle.digest("SHA-256", value)));
}
function encode(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function decode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1)
    throw codedError("EGRESS_KEY", "Invalid base64url key");
  try {
    return Uint8Array.from(
      atob(
        value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4),
      ),
      (c) => c.charCodeAt(0),
    );
  } catch {
    throw codedError("EGRESS_KEY", "Invalid base64url key");
  }
}
async function importKey(value: string | undefined) {
  if (!value) throw codedError("EGRESS_KEY", "EGRESS_KEY is required to use secrets");
  const raw = decode(value);
  if (raw.byteLength !== 32)
    throw codedError("EGRESS_KEY", "EGRESS_KEY must encode exactly 32 bytes");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
function canonical(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}
