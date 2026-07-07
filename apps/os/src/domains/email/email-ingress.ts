// The inbound email door: the OS worker's `email()` handler body. Cloudflare
// Email Routing delivers every message for a catch-all'd project hostname
// base (e.g. `*@iterate.app`) here; this module resolves the addressed
// project, enforces the sender policy, parses the MIME, and appends one
// `email/received` event to the project's `/integrations/email` stream — the
// email router processor (email-processor-implementation.ts) takes it from
// there. Deliberately shaped after the Slack webhook ingress
// (slack-webhook-api.ts): verify → resolve project → verbatim-ish capture;
// interpretation belongs to downstream processors.
//
// Response semantics differ from Slack's ACK-everything rule, because SMTP
// has a real reject channel: `setReject` returns a permanent 5xx to the
// sending MTA (a bounce the sender can see), while a thrown error is a
// temporary failure the sender retries. Unroutable or unauthorized mail is
// permanently rejected; infra errors are left to throw so legitimate mail
// retries instead of vanishing.

import PostalMime, { type Email } from "postal-mime";
import { itxEnv } from "../../env.ts";
import { parseConfig } from "../../config.ts";
import { readProjectBySlug } from "../../project-directory.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { buildDurableObjectProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { integrationStreamStub } from "../integrations/integration-streams.ts";
import { EmailProcessorContract } from "./email-processor-contract.ts";
import {
  EMAIL_BODY_TRUNCATE_CHARS,
  EMAIL_INTEGRATION_STREAM_PATH,
  EMAIL_MAX_RAW_SIZE_BYTES,
  EMAIL_RECEIVED_EVENT_TYPE,
  EMAIL_REJECTED_EVENT_TYPE,
  dmarcPasses,
  normalizeMessageId,
  parseInboundRecipient,
  parseMessageIdList,
  senderMatchesAllowlist,
} from "./utils.ts";

export async function handleInboundEmail(message: ForwardableEmailMessage): Promise<void> {
  const config = parseConfig(itxEnv);

  const recipient = parseInboundRecipient(message.to);
  if (recipient === null || !config.projectHostnameBases.includes(recipient.domain)) {
    message.setReject("No such address.");
    return;
  }
  const project = await readProjectBySlug(config, itxEnv.PROJECT_DIRECTORY, recipient.slug);
  if (project === null) {
    message.setReject("No such address.");
    return;
  }

  const rejectMail = async (reason: string, rejectMessage: string) => {
    // Envelope-sized audit fact — the project can see someone knocked, but
    // rejected bodies are never stored.
    await integrationStreamStub(project.id, EMAIL_INTEGRATION_STREAM_PATH).append({
      type: EMAIL_REJECTED_EVENT_TYPE,
      idempotencyKey: `email-rejected:${crypto.randomUUID()}`,
      payload: {
        envelope: { from: message.from, to: message.to },
        projectId: project.id,
        reason,
      },
    });
    message.setReject(rejectMessage);
  };

  if (message.rawSize > EMAIL_MAX_RAW_SIZE_BYTES) {
    await rejectMail("message-too-large", "Message too large.");
    return;
  }

  const parsed = await PostalMime.parse(message.raw);
  const fromAddress = mailboxAddress(parsed.from) ?? message.from;
  const authenticationResults = message.headers.get("authentication-results");

  // The sender policy: allowlisted AND DMARC-authenticated. Matching the From
  // header against the allowlist authenticates nothing by itself — anyone can
  // write any From — so a DMARC pass from Cloudflare's inbound MX is required
  // unless the deployment explicitly opts out (local dev, tests).
  if (!senderMatchesAllowlist({ address: fromAddress, patterns: config.email.allowedSenders })) {
    await rejectMail("sender-not-allowed", "Sender not authorized for this address.");
    return;
  }
  if (config.email.requireDmarc && !dmarcPasses(authenticationResults)) {
    await rejectMail("dmarc-fail", "Sender not authorized for this address.");
    return;
  }

  const receivedEvent = {
    type: EMAIL_RECEIVED_EVENT_TYPE,
    // The recipient is part of the key: one message delivered to two of the
    // project's addresses (To + Cc'd thread tag) is two routing decisions.
    idempotencyKey: `email-received:${normalizeMessageId(parsed.messageId) ?? crypto.randomUUID()}:${message.to.toLowerCase()}`,
    payload: {
      envelope: { from: message.from, to: message.to },
      recipient: { slug: recipient.slug, threadId: recipient.threadId },
      projectId: project.id,
      automated: isAutomatedMail(parsed, message.from),
      message: {
        messageId: normalizeMessageId(parsed.messageId),
        inReplyTo: normalizeMessageId(parsed.inReplyTo),
        references: parseMessageIdList(parsed.references),
        from: { address: mailboxAddress(parsed.from), name: parsed.from?.name },
        replyToAddress: mailboxAddress(parsed.replyTo?.[0]),
        subject: parsed.subject,
        ...truncatedBody("text", parsed.text),
        ...truncatedBody("html", parsed.html),
        // Metadata only in this slice: attachment bytes are dropped at the
        // door (loudly, via the transcription) rather than silently.
        attachments: parsed.attachments.map((attachment) => ({
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          size: attachmentSize(attachment.content),
        })),
      },
    },
  };

  // The subscription append is belt-and-braces for projects born before the
  // email router existed (the project processor's create lane arms it for new
  // projects): idempotency-keyed, so it is a no-op every time after the first.
  await integrationStreamStub(project.id, EMAIL_INTEGRATION_STREAM_PATH).append(
    buildDurableObjectProcessorSubscriptionConfiguredEvent({
      durableObjectName: DurableObjectNameCodec.stringify({
        projectId: project.id,
        path: EMAIL_INTEGRATION_STREAM_PATH,
      }),
      idempotencyKey: `email-router-subscription:${project.id}`,
      processorSlug: EmailProcessorContract.slug,
      subscriberType: "project",
    }),
    receivedEvent,
  );
}

/** The address of a postal-mime Address, which may be a mailbox or a group. */
function mailboxAddress(address: Email["from"] | undefined): string | undefined {
  if (address === undefined) return undefined;
  if (address.address !== undefined) return address.address;
  return address.group?.find((mailbox) => mailbox.address !== undefined)?.address;
}

function truncatedBody(key: "text" | "html", value: string | undefined) {
  if (value === undefined) return {};
  if (value.length <= EMAIL_BODY_TRUNCATE_CHARS) return { [key]: value };
  return { [key]: `${value.slice(0, EMAIL_BODY_TRUNCATE_CHARS)}\n[truncated]` };
}

function attachmentSize(content: ArrayBuffer | Uint8Array | string): number {
  if (typeof content === "string") return content.length;
  return content.byteLength;
}

/**
 * The classic mail-loop guards: automated senders get recorded but must never
 * trigger an automated reply. Auto-Submitted (RFC 3834), bulk/list/junk
 * Precedence, and mailer-daemon/postmaster envelope senders all qualify.
 */
function isAutomatedMail(parsed: Email, envelopeFrom: string): boolean {
  const header = (key: string) =>
    parsed.headers
      .find((entry) => entry.key === key)
      ?.value.trim()
      .toLowerCase();
  const autoSubmitted = header("auto-submitted");
  if (autoSubmitted !== undefined && autoSubmitted !== "no") return true;
  const precedence = header("precedence");
  if (precedence === "bulk" || precedence === "list" || precedence === "junk") return true;
  const sender = envelopeFrom.trim().toLowerCase();
  return sender.startsWith("mailer-daemon@") || sender.startsWith("postmaster@");
}
