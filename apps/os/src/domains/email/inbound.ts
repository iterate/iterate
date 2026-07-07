// The shared inbound-email core (tasks/email-agent-zero-onboarding.md).
//
// Every inbound path — the worker's real `email()` handler and the
// admin-gated inject route — funnels raw MIME through handleInboundEmail, so
// parsing, sender verification, guards, and routing are identical (and
// e2e-covered) regardless of how the mail arrived. Only Cloudflare-specific
// plumbing (stream draining, setReject) stays in the adapters.
//
// All egress is dependency-injected (InboundEmailDeps): this module never
// touches worker bindings, so the pipeline unit-tests with plain fakes.

import PostalMime, { type Email as ParsedMimeEmail } from "postal-mime";
import type { AppConfig } from "../../config.ts";
import {
  EMAIL_RECEIVED_EVENT_TYPE,
  normalizeEmailAddress,
  normalizeMessageId,
  parseEmailRecipient,
} from "./utils.ts";

/** Below Cloudflare's platform limit so storage/processing costs stay predictable. */
export const MAX_INBOUND_EMAIL_BYTES = 1_000_000;

export type InboundEmailInput = {
  envelopeFrom: string;
  envelopeTo: string;
  rawMime: string | Uint8Array;
};

export type InboundEmailDeps = {
  config: AppConfig;
  /**
   * The email sender directory: existing claim wins; an unclaimed sender is
   * provisioned (user + org + project) only when `allowProvision` is true.
   * Must be race-safe for concurrent first contact — see resolveSenderProject
   * in src/email-ingress.ts. Returns null when unclaimed and not provisionable.
   */
  resolveSenderProject(input: {
    address: string;
    name: string | undefined;
    allowProvision: boolean;
  }): Promise<{ projectId: string; provisioned: boolean } | null>;
  /** Slug → projectId for `<slug>@<domain>` thread-continuation mail. */
  lookupProjectIdBySlug(slug: string): Promise<string | null>;
  /** Append one event to the project's /integrations/email stream. */
  appendEmailReceived(input: {
    projectId: string;
    event: { type: string; idempotencyKey: string; payload: Record<string, unknown> };
  }): Promise<void>;
};

export type InboundEmailResult =
  | { outcome: "routed"; projectId: string; provisioned: boolean; messageId: string }
  | { outcome: "dropped"; reason: string; detail?: string };

/** What the email/received stream event carries (also the agent-visible shape). */
export type InboundEmailPayload = {
  projectId: string;
  /** Why this mail routed here: the bot inbox or the project's own address. */
  recipient: { kind: "zero-onboarding" | "project"; address: string };
  from: { address: string; name?: string };
  subject: string;
  text?: string;
  html?: string;
  messageId: string;
  inReplyTo?: string;
  references: string[];
  /** Metadata only — attachment bodies are not stored (v1). */
  attachments: { filename?: string; mimeType?: string; sizeBytes: number }[];
  provisioned: boolean;
};

export async function handleInboundEmail(
  input: InboundEmailInput,
  deps: InboundEmailDeps,
): Promise<InboundEmailResult> {
  const rawSize =
    typeof input.rawMime === "string"
      ? new TextEncoder().encode(input.rawMime).byteLength
      : input.rawMime.byteLength;
  if (rawSize > MAX_INBOUND_EMAIL_BYTES) {
    return dropped("message-too-large", `${rawSize} bytes > ${MAX_INBOUND_EMAIL_BYTES}`);
  }

  const domain = deps.config.projectHostnameBases[0];
  if (!domain) return dropped("no-email-domain-configured");

  let email: ParsedMimeEmail;
  try {
    email = await new PostalMime().parse(input.rawMime);
  } catch (error) {
    return dropped("unparseable-mime", error instanceof Error ? error.message : String(error));
  }

  const loopReason = mailLoopReason(email.headers);
  if (loopReason) return dropped("mail-loop-guard", loopReason);

  // Identity is the From HEADER address (what the sender's replies come back
  // to), never the envelope sender — but only once Authentication-Results
  // proves the authenticated domain aligns with it (below).
  const fromAddress = normalizeEmailAddress(email.from?.address || input.envelopeFrom);
  if (!fromAddress.includes("@")) return dropped("missing-from-address");
  const fromDomain = fromAddress.slice(fromAddress.lastIndexOf("@") + 1);

  const recipient = parseEmailRecipient({ address: input.envelopeTo, domain });
  if (recipient.kind === "reserved") return dropped("reserved-recipient", recipient.localPart);
  if (recipient.kind === "unroutable") return dropped(recipient.reason);

  const verification = verifySenderAlignment({
    authenticationResults: headerValues(email.headers, "authentication-results"),
    fromDomain,
  });
  if (!verification.verified) {
    // Drop with NO reply or bounce: answering unverified mail would make this
    // handler an oracle for spoofed senders.
    return dropped("sender-not-verified", verification.reason);
  }

  let projectId: string;
  let provisioned = false;
  if (recipient.kind === "zero-onboarding") {
    const resolved = await deps.resolveSenderProject({
      address: fromAddress,
      name: email.from?.name || undefined,
      allowProvision: deps.config.emailZeroOnboardingEnabled,
    });
    if (!resolved) return dropped("zero-onboarding-disabled");
    projectId = resolved.projectId;
    provisioned = resolved.provisioned;
  } else {
    const found = await deps.lookupProjectIdBySlug(recipient.slug);
    if (!found) return dropped("unknown-project", recipient.slug);
    projectId = found;
  }

  const messageId = email.messageId
    ? normalizeMessageId(email.messageId)
    : `synthetic-${await sha256Hex(input.rawMime)}`;

  const payload: InboundEmailPayload = {
    projectId,
    recipient: {
      kind: recipient.kind,
      address: normalizeEmailAddress(input.envelopeTo),
    },
    from: {
      address: fromAddress,
      ...(email.from?.name ? { name: email.from.name } : {}),
    },
    subject: email.subject || "",
    ...(email.text ? { text: email.text.trimEnd() } : {}),
    ...(email.html ? { html: email.html } : {}),
    messageId,
    ...(email.inReplyTo ? { inReplyTo: normalizeMessageId(email.inReplyTo) } : {}),
    references: parseReferences(email.references),
    attachments: (email.attachments || []).map((attachment) => ({
      ...(attachment.filename ? { filename: attachment.filename } : {}),
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      sizeBytes: attachmentSize(attachment.content),
    })),
    provisioned,
  };

  await deps.appendEmailReceived({
    projectId,
    event: {
      type: EMAIL_RECEIVED_EVENT_TYPE,
      idempotencyKey: `email-received:${messageId}`,
      payload,
    },
  });

  return { outcome: "routed", projectId, provisioned, messageId };
}

function dropped(reason: string, detail?: string): InboundEmailResult {
  console.warn(`[email-inbound] dropped: ${reason}${detail ? ` (${detail})` : ""}`);
  return { outcome: "dropped", reason, ...(detail ? { detail } : {}) };
}

type ParsedHeader = { key: string; value: string };

function headerValues(headers: ParsedHeader[], key: string): string[] {
  return headers.filter((header) => header.key.toLowerCase() === key).map((h) => h.value);
}

/**
 * Auto-generated mail must never wake an agent (which might auto-reply back —
 * a mail loop). Same guard the sibling recipient-inbox task calls for.
 */
function mailLoopReason(headers: ParsedHeader[]): string | null {
  for (const value of headerValues(headers, "auto-submitted")) {
    if (value.trim().toLowerCase() !== "no") return `auto-submitted: ${value}`;
  }
  for (const value of headerValues(headers, "precedence")) {
    const normalized = value.trim().toLowerCase();
    if (["bulk", "list", "junk", "auto_reply"].includes(normalized)) {
      return `precedence: ${value}`;
    }
  }
  if (headerValues(headers, "list-id").length > 0) return "list-id present";
  return null;
}

export type SenderVerification = { verified: true } | { verified: false; reason: string };

/**
 * The trust gate: Cloudflare Email Routing computes SPF/DKIM/DMARC before
 * invoking the worker and records the verdicts in Authentication-Results
 * headers. A sender is verified when `dmarc=pass` (alignment with the From
 * domain is DMARC's definition), or when `dkim=pass` and the DKIM domain
 * aligns with the From-header domain (RFC 7489 relaxed alignment). SPF alone
 * never suffices: forwarding breaks it, and the envelope sender it covers can
 * differ from the From header our identity keys on.
 */
export function verifySenderAlignment(input: {
  authenticationResults: string[];
  fromDomain: string;
}): SenderVerification {
  if (input.authenticationResults.length === 0) {
    return { verified: false, reason: "no authentication-results header" };
  }
  const fromDomain = input.fromDomain.toLowerCase();
  const seen: string[] = [];
  for (const header of input.authenticationResults) {
    // `authserv-id; method=result key=value ...; method=result ...`
    for (const clause of header.split(";").slice(1)) {
      const parsed = parseAuthClause(clause);
      if (!parsed) continue;
      seen.push(`${parsed.method}=${parsed.result}`);
      if (parsed.result !== "pass") continue;
      if (parsed.method === "dmarc") return { verified: true };
      if (parsed.method === "dkim") {
        const dkimDomain = parsed.params["header.d"] || domainOfIdentity(parsed.params["header.i"]);
        if (dkimDomain && domainsAlignRelaxed(dkimDomain, fromDomain)) {
          return { verified: true };
        }
      }
    }
  }
  return {
    verified: false,
    reason: `no aligned pass for ${fromDomain} in [${seen.join(", ")}]`,
  };
}

function parseAuthClause(
  clause: string,
): { method: string; result: string; params: Record<string, string> } | null {
  const tokens = clause.trim().split(/\s+/).filter(Boolean);
  const head = tokens[0];
  if (!head) return null;
  const match = /^([a-z0-9-]+)=([a-z0-9]+)$/i.exec(head);
  if (!match) return null;
  const params: Record<string, string> = {};
  for (const token of tokens.slice(1)) {
    const eq = token.indexOf("=");
    if (eq <= 0) continue;
    params[token.slice(0, eq).toLowerCase()] = token.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { method: match[1]!.toLowerCase(), result: match[2]!.toLowerCase(), params };
}

function domainOfIdentity(identity: string | undefined): string | undefined {
  if (!identity) return undefined;
  const at = identity.lastIndexOf("@");
  return at >= 0 ? identity.slice(at + 1) : identity;
}

/**
 * RFC 7489 relaxed alignment, approximated without a public-suffix list: the
 * domains are equal, or one is a parent of the other at a label boundary
 * (mail.gmail.com aligns with gmail.com).
 */
export function domainsAlignRelaxed(a: string, b: string): boolean {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
}

function parseReferences(references: string | string[] | undefined): string[] {
  if (!references) return [];
  const values = Array.isArray(references) ? references : references.split(/\s+/);
  return values.filter(Boolean).map(normalizeMessageId);
}

function attachmentSize(content: unknown): number {
  if (typeof content === "string") return new TextEncoder().encode(content).byteLength;
  if (content instanceof ArrayBuffer) return content.byteLength;
  if (ArrayBuffer.isView(content)) return content.byteLength;
  return 0;
}

async function sha256Hex(rawMime: string | Uint8Array): Promise<string> {
  const bytes = typeof rawMime === "string" ? new TextEncoder().encode(rawMime) : rawMime;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
