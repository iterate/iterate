// First-party email helpers (the `itx.email` capability + inbound routing).
// Pure helpers only — the env-touching send orchestration lives in
// rpc-targets.ts's EmailRpcTarget, and inbound ingress in inbound.ts.
// Recipient-inbox (`<slug>@`) semantics beyond thread continuation are the
// follow-up half of tasks/os-agent-email-cloudflare-workers.md.

import { RESERVED_PLATFORM_SLUGS } from "@iterate-com/shared/slug";

/** Stream that receives the project's email audit trail + inbound mail events. */
export const EMAIL_INTEGRATION_STREAM_PATH = "/integrations/email";
export const EMAIL_SENT_EVENT_TYPE = "events.iterate.com/email/sent";
export const EMAIL_RECEIVED_EVENT_TYPE = "events.iterate.com/email/received";
export const EMAIL_THREAD_ROUTE_CONFIGURED_EVENT_TYPE =
  "events.iterate.com/email/thread-route-configured";

/**
 * Deployment-wide (projectId: null) stream mapping verified sender addresses
 * to the project provisioned for them ("Email Sender Claim" — CONTEXT.md).
 * Mirrors the Slack team directory, except claims are appended by the email
 * ingress itself on first contact rather than by a project's connect flow.
 */
export const EMAIL_SENDER_DIRECTORY_STREAM_PATH = "/integrations/email-sender-directory";
export const EMAIL_SENDER_CLAIMED_EVENT_TYPE = "events.iterate.com/email/sender-claimed";

/**
 * The zero-onboarding inbox: mail to `bot@<projectHostnameBases[0]>` maps the
 * SENDER to a project (provisioning user/org/project on first contact).
 * Reserved as a slug platform-wide via RESERVED_PLATFORM_SLUGS.
 */
export const ZERO_ONBOARDING_LOCAL_PART = "bot";

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
    /** Allowlisted custom MIME headers (In-Reply-To and References are allowed;
     * Message-ID is platform-generated — see
     * https://developers.cloudflare.com/email-service/reference/headers/). */
    headers?: Record<string, string>;
  }): Promise<unknown>;
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

/** What `itx.email.send` accepts — see EmailCapability in types.ts for the contract docs. */
type SendProjectEmailRequest = {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  from?: string;
  inReplyTo?: string;
  references?: string[];
};

/**
 * Builds the Email Service message for a project send, enforcing the sender
 * rule: mail only ever leaves from the project's own address. An explicit
 * `from` must match it (case-insensitively) — a project can never send as
 * another project or an arbitrary address.
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
  const headers: Record<string, string> = {};
  if (request.inReplyTo) headers["In-Reply-To"] = ensureAngleBrackets(request.inReplyTo);
  if (request.references && request.references.length > 0) {
    headers.References = request.references.map(ensureAngleBrackets).join(" ");
  }
  return {
    from: { email: from, name: projectName },
    to: request.to,
    subject: request.subject,
    ...(request.text ? { text: request.text } : {}),
    ...(request.html ? { html: request.html } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

/**
 * The sender identity primitive: lowercase only. `+tags` and dots are
 * deliberately preserved — `joe+x@gmail.com` is a distinct identity from
 * `joe@gmail.com` (and that is a feature for testing).
 */
export function normalizeEmailAddress(address: string): string {
  return address.trim().toLowerCase();
}

/** RFC 5322 message ids compare without their angle brackets, case-insensitively. */
export function normalizeMessageId(messageId: string): string {
  return messageId.trim().replace(/^</, "").replace(/>$/, "").toLowerCase();
}

function ensureAngleBrackets(messageId: string): string {
  const trimmed = messageId.trim();
  return trimmed.startsWith("<") ? trimmed : `<${trimmed}>`;
}

export type EmailRecipient =
  | { kind: "zero-onboarding" }
  | { kind: "project"; slug: string }
  | { kind: "reserved"; localPart: string }
  | { kind: "unroutable"; reason: string };

/**
 * Classifies an inbound recipient address on the deployment's email domain.
 * `bot@<domain>` is the zero-onboarding inbox; other reserved local parts are
 * platform addresses (never a project); everything else is treated as a
 * project slug. Sub-addressed agent inboxes (`<slug>+p_<path>@`) belong to
 * tasks/os-agent-email-cloudflare-workers.md and currently classify as
 * unroutable.
 */
export function parseEmailRecipient(input: { address: string; domain: string }): EmailRecipient {
  const normalized = normalizeEmailAddress(input.address);
  const atIndex = normalized.lastIndexOf("@");
  if (atIndex <= 0) return { kind: "unroutable", reason: "malformed-recipient" };
  const localPart = normalized.slice(0, atIndex);
  const recipientDomain = normalized.slice(atIndex + 1);
  if (recipientDomain !== input.domain.toLowerCase()) {
    return { kind: "unroutable", reason: "wrong-domain" };
  }
  if (localPart === ZERO_ONBOARDING_LOCAL_PART) return { kind: "zero-onboarding" };
  if (localPart.includes("+")) return { kind: "unroutable", reason: "subaddress-not-supported" };
  if (RESERVED_PLATFORM_SLUGS.includes(localPart)) return { kind: "reserved", localPart };
  return { kind: "project", slug: localPart };
}

/** The routed agent stream path for one email thread. Stable wire shape. */
export function emailThreadStreamPath(rootMessageId: string): string {
  const normalized = normalizeMessageId(rootMessageId);
  const sanitized = normalized.replace(/[^a-z0-9_-]+/g, "-");
  const part =
    sanitized.length <= 40 ? sanitized : `${sanitized.slice(0, 24)}-${fnv1aHex(normalized)}`;
  return `/agents/email/thread-${part}`;
}

export function isEmailAgentPath(agentPath: string): boolean {
  const normalized = agentPath.toLowerCase();
  return normalized === "/agents/email" || normalized.startsWith("/agents/email/");
}

function fnv1aHex(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Folds the deployment-wide email sender directory. FIRST claim wins per
 * address: claims are append-once (idempotency-keyed on the normalized
 * address), and a deterministic winner makes the provisioning race safe —
 * a concurrent loser reads the directory back and adopts the winning project.
 */
export function foldEmailSenderDirectory(
  events: readonly { type: string; payload?: unknown }[],
): Map<string, string> {
  const claims = new Map<string, string>();
  for (const event of events) {
    if (event.type !== EMAIL_SENDER_CLAIMED_EVENT_TYPE) continue;
    const payload = event.payload as { address?: unknown; projectId?: unknown };
    if (typeof payload?.address !== "string" || typeof payload?.projectId !== "string") continue;
    if (!claims.has(payload.address)) claims.set(payload.address, payload.projectId);
  }
  return claims;
}
