// First-party email (the `itx.email` capability): pure helpers only — the
// env-touching send orchestration lives in rpc-targets.ts's
// EmailCapabilityRpcTarget and the inbound door in email-ingress.ts. Inbound
// mail routes through the "email" processor on `/integrations/email` into one
// agent stream per email thread (`/agents/email/t<threadId>`); see
// email-processor-contract.ts.

import { normalizeProjectHostnameBase } from "../../lib/project-host-routing.ts";

/** Stream that receives the project's email traffic: `email/sent` audit
 * events, inbound `email/received`/`email/rejected` events, and the email
 * router's `email/thread-route-configured` facts. */
export const EMAIL_INTEGRATION_STREAM_PATH = "/integrations/email";

/** Inbound messages larger than this are rejected at the door (Cloudflare
 * itself caps inbound at 25 MiB; this keeps stream events and parse memory
 * predictable). */
export const EMAIL_MAX_RAW_SIZE_BYTES = 15 * 1024 * 1024;

/** Text/html bodies are truncated to this many characters before they land in
 * a stream event, so one large email cannot blow the event-row size budget. */
export const EMAIL_BODY_TRUNCATE_CHARS = 100_000;

/** Cloudflare Email Service outbound limits: at most 32 attachments and a
 * 5 MiB total message size (bodies + base64-encoded attachments).
 * https://developers.cloudflare.com/email-service/platform/limits/ */
const EMAIL_MAX_ATTACHMENTS = 32;
export const EMAIL_MAX_MESSAGE_BYTES = 5 * 1024 * 1024;

/**
 * The structured `send()` surface of a Cloudflare Email Service `send_email`
 * worker binding. Hand-written because the pinned @cloudflare/workers-types
 * only ships the legacy raw-MIME EmailMessage shape; mirrors
 * https://developers.cloudflare.com/email-service/api/send-emails/workers-api/.
 */
export type SendEmailBinding = {
  send(message: {
    to: string | EmailParty | Array<string | EmailParty>;
    from: string | EmailParty;
    subject: string;
    text?: string;
    html?: string;
    replyTo?: string | EmailParty;
    headers?: Record<string, string>;
    attachments?: OutboundEmailAttachment[];
  }): Promise<unknown>;
};

/**
 * One outbound email attachment as the CALLER passes it: either a stored
 * project file addressed by its `itx.files` path, or inline base64 content
 * for bytes the caller already holds. Any file type works (PDFs, images,
 * archives, …) within the Email Service limits: 32 attachments, 5 MiB total
 * message size.
 */
export type EmailAttachmentInput =
  | {
      /** Project file path (`itx.files.get(path)`) to attach. */
      path: string;
      /** Override the attachment filename; defaults to the path's last segment. */
      filename?: string;
      /** Override the MIME type; defaults to the stored file's contentType. */
      contentType?: string;
    }
  | {
      filename: string;
      /** Base64-encoded content. */
      data: string;
      /** MIME type; defaults to application/octet-stream. */
      contentType?: string;
    };

/** One outbound attachment in the Email Service structured send() shape. */
export type OutboundEmailAttachment = {
  /** Base64 string or raw bytes. */
  content: string | ArrayBuffer | ArrayBufferView;
  filename: string;
  /** MIME type. */
  type: string;
  disposition: "attachment" | "inline";
  contentId?: string;
};

/** One addressable mailbox in the Email Service structured send() shape. */
type EmailParty = {
  email: string;
  name?: string;
};

/**
 * THE deployment's email domain: the first project hostname base, normalized
 * exactly the way host routing normalizes bases (lowercase, `*.` wildcard and
 * port stripped — see normalizeProjectHostnameBase). Inbound acceptance and
 * every outbound From/Reply-To derive from this one function, so a config
 * value like `*.iterate-preview-3.app` can never make the door and the sender
 * identity disagree. Null when the deployment has no hostname base.
 */
export function emailDomainForDeployment(projectHostnameBases: readonly string[]): string | null {
  const base = projectHostnameBases[0];
  if (!base) return null;
  const normalized = normalizeProjectHostnameBase(base);
  return normalized === "" ? null : normalized;
}

/** The project's own sending identity: `<slug>@<sender domain>`. */
export function emailAddressForProject(input: { slug: string; domain: string }): string {
  return `${input.slug}@${input.domain}`;
}

/**
 * The reply-routing address for one email thread:
 * `<slug>+t<threadId>@<domain>`. Set as Reply-To on every threaded outbound
 * message so replies carry their own route back to the thread stream, without
 * depending on mail clients preserving In-Reply-To/References headers.
 */
export function emailThreadReplyAddress(input: {
  slug: string;
  domain: string;
  threadId: string;
}): string {
  return `${input.slug}+t${input.threadId}@${input.domain}`;
}

/** The agent stream path for one email thread. Stable wire shape. */
export function emailAgentPath(threadId: string): string {
  return `/agents/email/t${threadId}`;
}

/**
 * Thread id for an agent-INITIATED email conversation (an agent-scoped
 * `itx.email.send`): random where inbound thread ids are stream offsets,
 * because a send happens in an RPC action with no offset to key on. The `a`
 * prefix marks agent-initiated threads in logs and Reply-To tags; the
 * alphabet stays inside the `+t<threadId>` tag grammar (`[a-z0-9-]+`).
 */
export function mintOutboundEmailThreadId(): string {
  return `a${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function isEmailAgentPath(agentPath: string): boolean {
  const normalized = agentPath.toLowerCase();
  return normalized === "/agents/email" || normalized.startsWith("/agents/email/");
}

/**
 * A parsed inbound recipient address on a project hostname base:
 * `<slug>@<domain>` (project inbox) or `<slug>+t<threadId>@<domain>` (thread
 * reply address). Unknown `+` tags parse with `threadId: null` — the router
 * falls back to header matching rather than trusting an unrecognized tag.
 */
type InboundEmailRecipient = {
  domain: string;
  slug: string;
  threadId: string | null;
};

export function parseInboundRecipient(address: string): InboundEmailRecipient | null {
  const trimmed = address.trim().toLowerCase().replace(/^<|>$/g, "");
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  const localPart = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const plus = localPart.indexOf("+");
  const slug = plus === -1 ? localPart : localPart.slice(0, plus);
  if (!slug.length) return null;
  const tag = plus === -1 ? null : localPart.slice(plus + 1);
  const threadId = tag && /^t[a-z0-9-]+$/.test(tag) ? tag.slice(1) : null;
  return { domain, slug, threadId };
}

/**
 * Matches one sender address against allowlist patterns: exact addresses
 * (`jonas@example.com`) or whole domains (`*@example.com`), case-insensitive.
 * An empty pattern list matches nothing — inbound email is closed by default.
 */
export function senderMatchesAllowlist(input: { address: string; patterns: string[] }): boolean {
  const address = input.address.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at <= 0) return false;
  const domain = address.slice(at + 1);
  return input.patterns.some((pattern) => {
    const normalized = pattern.trim().toLowerCase();
    if (normalized.startsWith("*@")) return domain === normalized.slice(2);
    return address === normalized;
  });
}

/**
 * Canonical form for one project-scoped inbound sender rule. The supported
 * grammar deliberately matches the ingress policy: one exact mailbox or one
 * whole-domain wildcard, never an arbitrary glob.
 */
export function normalizeInboundEmailAllowedSender(pattern: string): string {
  const normalized = pattern.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (
    at <= 0 ||
    at === normalized.length - 1 ||
    /\s/.test(normalized) ||
    domain.includes("@") ||
    domain.startsWith(".") ||
    domain.endsWith(".") ||
    !domain.includes(".") ||
    (local.includes("*") && local !== "*")
  ) {
    throw new Error(
      `Inbound email sender ${JSON.stringify(pattern)} must be an exact address or *@domain.`,
    );
  }
  return `${local}@${domain}`;
}

/**
 * True when Cloudflare's inbound MX reports `dmarc=pass` on an
 * Authentication-Results header. The sender allowlist alone authenticates
 * nothing — anyone can put an allowlisted address in the From header — so
 * this gate requires the trusted authserv-id (`mx.cloudflare.net`) on an
 * AR record that contains `dmarc=pass`.
 *
 * Callers pass `headers.get("authentication-results")`, which joins
 * duplicate AR headers with `", "`. We split those into records carefully
 * (see `splitAuthenticationResultsRecords`) and use the **last**
 * Cloudflare-authored record — MTAs append their AR last, so a trailing
 * real CF fail is not overridden by an earlier forgery.
 */
export function dmarcPasses(authenticationResults: string | null): boolean {
  if (!authenticationResults) return false;

  let lastCloudflareRecord: string | undefined;
  for (const record of splitAuthenticationResultsRecords(authenticationResults)) {
    const trimmed = record.trim();
    // Exact authserv-id (optional version digit), then ";". A word-boundary
    // pin would accept forgeries like mx.cloudflare.net.evil / net-evil.
    if (/^mx\.cloudflare\.net(?:\s+\d+)?\s*;/i.test(trimmed)) {
      lastCloudflareRecord = trimmed;
    }
  }
  return !!lastCloudflareRecord && /\bdmarc=pass\b/i.test(lastCloudflareRecord);
}

/**
 * Split a combined Authentication-Results value into records.
 *
 * - Newlines separate records (raw MIME / multi-line).
 * - Commas from `Headers.get` also separate records, but only when the text
 *   *before* the comma is already a complete AR record (`authserv-id; …`).
 *   That blocks `evil, mx.cloudflare.net; dmarc=pass` from being treated as
 *   a synthetic Cloudflare record (the left side has no `;`).
 */
function splitAuthenticationResultsRecords(value: string): string[] {
  const records: string[] = [];
  for (const line of value.split(/\r?\n/)) {
    let start = 0;
    // Next record starts with authserv-id, optional version digit(s), then ";".
    // Without the version group, "mx.cloudflare.net 1; …" would not split after
    // a Headers.get join and legitimate CF-stamped mail would be dropped.
    const re = /,(?=\s*[^,;\s]+(?:\s+\d+)?\s*;)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(line))) {
      const left = line.slice(start, match.index);
      if (left.includes(";")) {
        records.push(left);
        start = match.index + 1;
      }
    }
    records.push(line.slice(start));
  }
  return records;
}

/**
 * True when an inbound mail's author is the receiving project's own address —
 * our outbound looping back (e.g. the counterpart auto-forwards into the same
 * inbox). Shared by the email-agent processor (must not wake the agent to
 * talk to itself) and email.reply's counterpart selection (must not reply to
 * ourselves). Structural input: the slice of an email/received payload both
 * callers hold.
 */
/** One bare, lowercased address from a possibly angle-bracketed value. */
function normalizeBareAddress(value: string | undefined): string | null {
  const trimmed = value?.trim().toLowerCase().replace(/^<|>$/g, "") ?? "";
  return trimmed.includes("@") ? trimmed : null;
}

/**
 * The slice of an email/received payload the counterpart/loop helpers below
 * read. Structural so the router, agent processor, and reply door can all
 * pass their parsed payloads without import cycles.
 */
type InboundMailIdentitySlice = {
  envelope: { from: string; to: string };
  recipient: { slug: string };
  message: { from: { address?: string }; replyToAddress?: string | null };
};

/**
 * True when `address` (bare, lowercased) belongs to the project receiving
 * this mail: the project inbox or any `+`-tagged variant of it. THE one
 * self-address predicate — the counterpart chain and the loop filter both use
 * it, so "what counts as our own address" can never diverge between them.
 */
function isProjectOwnedInboundAddress(address: string, payload: InboundMailIdentitySlice): boolean {
  const recipient = parseInboundRecipient(payload.envelope.to);
  if (!recipient) return false;
  const slug = payload.recipient.slug.toLowerCase();
  return (
    address === `${slug}@${recipient.domain}` ||
    (address.startsWith(`${slug}+`) && address.endsWith(`@${recipient.domain}`))
  );
}

/**
 * THE reply-target chain for one inbound mail: Reply-To when set, else the
 * header From, else the SMTP envelope from (the address ingress
 * authenticated). Candidates owned by the receiving project itself (the
 * project inbox or a `+`-tagged variant) are skipped — a Reply-To pointing
 * back at us must never make the agent mail itself instead of the human.
 * Every consumer — the router's route event, the email-agent processor's
 * state, email.reply's target — derives the counterpart from this one
 * function so they can never disagree.
 */
export function emailCounterpart(payload: InboundMailIdentitySlice): string | null {
  for (const candidate of [
    payload.message.replyToAddress ?? undefined,
    payload.message.from.address,
    payload.envelope.from,
  ]) {
    const normalized = normalizeBareAddress(candidate);
    if (normalized && !isProjectOwnedInboundAddress(normalized, payload)) {
      return normalized;
    }
  }
  return null;
}

export function isOwnProjectMail(payload: InboundMailIdentitySlice): boolean {
  // Header From when parsed, else the SMTP envelope from — mirrors the
  // counterpart fallback chain so the loop filter sees the same identity.
  const from = normalizeBareAddress(payload.message.from.address ?? payload.envelope.from);
  if (!from) return false;
  // Same predicate as the counterpart chain: the bare inbox AND any +tagged
  // variant count as our own mail.
  return isProjectOwnedInboundAddress(from, payload);
}

/**
 * Deterministic stand-in for a missing Message-ID, so idempotency keys stay
 * stable across MTA retries and worker replays: the same physical message
 * always hashes to the same key, instead of minting a fresh UUID per attempt
 * (which would duplicate events and spawn duplicate threads).
 */
export async function fallbackInboundMessageKey(input: {
  envelopeFrom: string;
  date: string | undefined;
  subject: string | undefined;
  body: string | undefined;
}): Promise<string> {
  const basis = JSON.stringify([
    input.envelopeFrom.toLowerCase(),
    input.date ?? "",
    input.subject ?? "",
    (input.body ?? "").slice(0, 4096),
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(basis));
  return `sha256-${[...new Uint8Array(digest).slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Strip whitespace and angle brackets from an RFC 5322 Message-ID. */
export function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/^<|>$/g, "").trim();
  return !trimmed.length ? null : trimmed;
}

/** Every `<...>` message id in a References/In-Reply-To header value, normalized. */
export function parseMessageIdList(value: string | null | undefined): string[] {
  if (!value) return [];
  const ids = value.match(/<[^<>\s]+>/g) ?? [];
  return ids.map((id) => normalizeMessageId(id)).filter((id): id is string => !!id && !!id.length);
}

/** Re-add the angle brackets an RFC 5322 message-id header value requires. */
function angleBracketed(messageId: string): string {
  return messageId.startsWith("<") ? messageId : `<${messageId}>`;
}

/** Prefix a subject with `Re:` unless some Re: variant is already there. */
export function replySubject(subject: string | undefined): string {
  const trimmed = subject?.trim() ?? "";
  if (!trimmed.length) return "Re:";
  return /^re\s*:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

/**
 * Enforces the Email Service message limits (attachment count + total message
 * bytes) so a too-big send fails here with a clear error instead of an opaque
 * binding rejection after the audit trail already moved. The byte total is
 * what goes on the wire: bodies plus attachments at their base64-encoded MIME
 * size (raw bytes inflate 4/3 in transit).
 */
export function assertEmailMessageWithinLimits(input: {
  attachments: OutboundEmailAttachment[];
  bodyBytes: number;
}): void {
  const { attachments, bodyBytes } = input;
  if (attachments.length > EMAIL_MAX_ATTACHMENTS) {
    throw new Error(
      `email attachments are limited to ${EMAIL_MAX_ATTACHMENTS} files; got ${attachments.length}.`,
    );
  }
  const totalBytes =
    bodyBytes +
    attachments.reduce((sum, attachment) => sum + encodedAttachmentBytes(attachment.content), 0);
  if (totalBytes > EMAIL_MAX_MESSAGE_BYTES) {
    throw new Error(
      `email messages are limited to ${EMAIL_MAX_MESSAGE_BYTES} bytes total including base64-encoded attachments (Email Service 5 MiB cap); got ${totalBytes}.`,
    );
  }
}

/** Wire (base64-encoded MIME) size of one attachment's content. String
 * content is already base64; raw bytes inflate 4/3 when encoded. */
function encodedAttachmentBytes(content: OutboundEmailAttachment["content"]): number {
  if (typeof content === "string") return content.length;
  return Math.ceil(content.byteLength / 3) * 4;
}

/** Decode one inline base64 attachment payload into bytes. */
export function decodeBase64Attachment(data: string): Uint8Array {
  const binary = atob(data.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * True when `address` belongs to this project: the project address itself or
 * a `+`-tagged variant of it (`slug+t42@domain`). The only addresses a
 * project may use as Reply-To.
 */
function isProjectOwnedAddress(address: string, projectAddress: string): boolean {
  const normalized = address.trim().toLowerCase();
  const project = projectAddress.toLowerCase();
  if (normalized === project) return true;
  const at = project.lastIndexOf("@");
  const slug = project.slice(0, at);
  const domain = project.slice(at);
  return normalized.startsWith(`${slug}+`) && normalized.endsWith(domain);
}

/** What `itx.email.send` accepts — see EmailCapabilityRpcTarget in
 * rpc-targets.ts for the contract docs. Attachments arrive already resolved to
 * bytes: the caller shape (`{ path }` project files / `{ data }` inline
 * base64) is resolved by EmailCapabilityRpcTarget before this pure layer sees
 * it. */
type SendProjectEmailRequest = {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  from?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: OutboundEmailAttachment[];
};

/**
 * Builds the Email Service message for a project send, enforcing the sender
 * rule: mail only ever leaves from the project's own address. An explicit
 * `from` must match it (case-insensitively) — a project can never send as
 * another project or an arbitrary address. `replyTo` may additionally be a
 * `+`-tagged variant of the project address (thread reply routing).
 */
export function buildProjectEmailMessage(input: {
  projectAddress: string;
  projectName: string;
  request: SendProjectEmailRequest;
}): Parameters<SendEmailBinding["send"]>[0] {
  const { projectAddress, projectName, request } = input;
  const from = request.from?.trim() || projectAddress;
  if (from.toLowerCase() !== projectAddress.toLowerCase()) {
    throw new Error(
      `email.send may only send from this project's own address (${projectAddress}); got "${from}".`,
    );
  }
  if (!request.text && !request.html) {
    throw new Error("email.send requires a text and/or html body.");
  }
  const replyTo = request.replyTo?.trim();
  if (replyTo && !isProjectOwnedAddress(replyTo, projectAddress)) {
    throw new Error(
      `email.send replyTo must be this project's own address or a +tagged variant of it (${projectAddress}); got "${replyTo}".`,
    );
  }
  const attachments = request.attachments ?? [];
  assertEmailMessageWithinLimits({
    attachments,
    // Char length ≈ bytes for these bodies (100KB truncation cap upstream vs
    // a 5 MiB limit — multi-byte slack is noise at this scale).
    bodyBytes: request.subject.length + (request.text?.length ?? 0) + (request.html?.length ?? 0),
  });
  const references = (request.references ?? []).map(angleBracketed).join(" ");
  const headers: Record<string, string> = {
    ...(request.inReplyTo && { "In-Reply-To": angleBracketed(request.inReplyTo) }),
    ...(references && { References: references }),
  };
  return {
    from: { email: from, name: projectName },
    to: request.to,
    subject: request.subject,
    ...(request.text && { text: request.text }),
    ...(request.html && { html: request.html }),
    ...(replyTo && { replyTo }),
    ...(!!Object.keys(headers).length && { headers }),
    ...(!!attachments.length && { attachments }),
  };
}
