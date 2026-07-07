// First-party email (the `itx.email` capability): pure helpers only — the
// env-touching send orchestration lives in rpc-targets.ts's EmailRpcTarget and
// the inbound door in email-ingress.ts. Inbound mail routes through the
// "email" processor on `/integrations/email` into one agent stream per email
// thread (`/agents/email/t<threadId>`); see email-processor-contract.ts.

/** Stream that receives the project's email traffic: `email/sent` audit
 * events, inbound `email/received`/`email/rejected` events, and the email
 * router's `email/thread-route-configured` facts. */
export const EMAIL_INTEGRATION_STREAM_PATH = "/integrations/email";
export const EMAIL_SENT_EVENT_TYPE = "events.iterate.com/email/sent";
export const EMAIL_RECEIVED_EVENT_TYPE = "events.iterate.com/email/received";
export const EMAIL_REJECTED_EVENT_TYPE = "events.iterate.com/email/rejected";

/** Inbound messages larger than this are rejected at the door (Cloudflare
 * itself caps inbound at 25 MiB; this keeps stream events and parse memory
 * predictable). */
export const EMAIL_MAX_RAW_SIZE_BYTES = 15 * 1024 * 1024;

/** Text/html bodies are truncated to this many characters before they land in
 * a stream event, so one large email cannot blow the event-row size budget. */
export const EMAIL_BODY_TRUNCATE_CHARS = 100_000;

/** Cloudflare Email Service outbound limits: at most 32 attachments and a
 * 5 MiB total message size (bodies + attachments).
 * https://developers.cloudflare.com/email-service/platform/limits/ */
const EMAIL_MAX_ATTACHMENTS = 32;
export const EMAIL_MAX_ATTACHMENT_TOTAL_BYTES = 5 * 1024 * 1024;

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

export function isEmailAgentPath(agentPath: string): boolean {
  const normalized = agentPath.toLowerCase();
  return normalized === "/agents/email" || normalized.startsWith("/agents/email/");
}

/** The `t<threadId>` segment of an email agent path, or null off-shape. */
export function emailThreadIdFromAgentPath(agentPath: string): string | null {
  const match = /^\/agents\/email\/t([a-z0-9-]+)$/i.exec(agentPath);
  return match?.[1] ?? null;
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
  if (slug.length === 0) return null;
  const tag = plus === -1 ? null : localPart.slice(plus + 1);
  const threadId = tag !== null && /^t[a-z0-9-]+$/.test(tag) ? tag.slice(1) : null;
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
 * True when an Authentication-Results header (added by Cloudflare's inbound
 * MX) reports `dmarc=pass`. Without this, the sender allowlist authenticates
 * nothing — anyone can put an allowlisted address in the From header.
 *
 * Spike caveat: this scans the combined Authentication-Results value rather
 * than verifying the authserv-id, so a sender who *also* forges an
 * `Authentication-Results: ...dmarc=pass` header of their own could satisfy
 * it. Acceptable while inbound is allowlist-gated to trusted senders;
 * production hardening should pin the `mx.cloudflare.net` authserv-id chunk.
 */
export function dmarcPasses(authenticationResults: string | null): boolean {
  if (authenticationResults === null) return false;
  return /\bdmarc=pass\b/i.test(authenticationResults);
}

/** Strip whitespace and angle brackets from an RFC 5322 Message-ID. */
export function normalizeMessageId(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim().replace(/^<|>$/g, "").trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Every `<...>` message id in a References/In-Reply-To header value, normalized. */
export function parseMessageIdList(value: string | null | undefined): string[] {
  if (value == null) return [];
  const ids = value.match(/<[^<>\s]+>/g) ?? [];
  return ids
    .map((id) => normalizeMessageId(id))
    .filter((id): id is string => id !== null && id.length > 0);
}

/** Re-add the angle brackets an RFC 5322 message-id header value requires. */
function angleBracketed(messageId: string): string {
  return messageId.startsWith("<") ? messageId : `<${messageId}>`;
}

/** Prefix a subject with `Re:` unless some Re: variant is already there. */
export function replySubject(subject: string | undefined): string {
  const trimmed = subject?.trim() ?? "";
  if (trimmed.length === 0) return "Re:";
  return /^re\s*:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

/**
 * Enforces the Email Service attachment limits (count + total bytes) so a
 * too-big send fails here with a clear error instead of an opaque binding
 * rejection after the audit trail already moved.
 */
export function assertAttachmentsWithinLimits(attachments: OutboundEmailAttachment[]): void {
  if (attachments.length > EMAIL_MAX_ATTACHMENTS) {
    throw new Error(
      `email attachments are limited to ${EMAIL_MAX_ATTACHMENTS} files; got ${attachments.length}.`,
    );
  }
  const totalBytes = attachments.reduce(
    (sum, attachment) => sum + attachmentContentBytes(attachment.content),
    0,
  );
  if (totalBytes > EMAIL_MAX_ATTACHMENT_TOTAL_BYTES) {
    throw new Error(
      `email attachments are limited to ${EMAIL_MAX_ATTACHMENT_TOTAL_BYTES} bytes total (Email Service 5 MiB message cap); got ${totalBytes}.`,
    );
  }
}

/** Decoded size of one attachment's content, base64-aware for string content. */
function attachmentContentBytes(content: OutboundEmailAttachment["content"]): number {
  if (typeof content !== "string") return content.byteLength;
  // Base64 decodes to 3/4 of its length, minus padding.
  const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
  return Math.floor((content.length * 3) / 4) - padding;
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

/** What `itx.email.send` accepts — see EmailCapability in types.ts for the
 * contract docs. Attachments arrive already resolved to bytes: the caller
 * shape (`{ path }` project files / `{ data }` inline base64) is resolved by
 * EmailRpcTarget before this pure layer sees it. */
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
  assertAttachmentsWithinLimits(attachments);
  const references = (request.references ?? []).map(angleBracketed).join(" ");
  const headers: Record<string, string> = {
    ...(request.inReplyTo ? { "In-Reply-To": angleBracketed(request.inReplyTo) } : {}),
    ...(references ? { References: references } : {}),
  };
  return {
    from: { email: from, name: projectName },
    to: request.to,
    subject: request.subject,
    ...(request.text ? { text: request.text } : {}),
    ...(request.html ? { html: request.html } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}
