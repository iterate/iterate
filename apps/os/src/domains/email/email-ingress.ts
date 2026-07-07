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
// Two recipient lanes share this door:
//
//   `<slug>@<domain>` — an existing project's inbox, closed behind the
//   deployment sender allowlist + DMARC (config.email). The one exception:
//   the sender a project was zero-onboarding-provisioned FOR (its Email
//   Sender Claim) may always mail it, subject to strict sender verification —
//   that is how thread replies to `<slug>+t<id>@` keep working for senders no
//   allowlist knows about.
//
//   `bot@<domain>` — the zero-onboarding inbox
//   (tasks/email-agent-zero-onboarding.md): open-world, gated by
//   config.email.zeroOnboardingEnabled plus UNCONDITIONAL sender verification
//   (verifySenderAlignment; no requireDmarc escape hatch). A verified unknown
//   sender gets a user/org/project provisioned on the spot
//   (zero-onboarding.ts) and the mail lands on the new project.
//
// Response semantics differ from Slack's ACK-everything rule, because SMTP
// has a real reject channel: `setReject` returns a permanent 5xx to the
// sending MTA (a bounce the sender can see), while a thrown error is a
// temporary failure the sender retries. Unroutable or unauthorized mail is
// permanently rejected; infra errors are left to throw so legitimate mail
// retries instead of vanishing. Bot-lane verification failures are the one
// accept-and-drop case: bouncing would make the door an oracle for spoofed
// senders, so the mail is accepted, logged, and discarded.

import PostalMime, { type Email } from "postal-mime";
import { itxEnv } from "../../env.ts";
import { parseConfig } from "../../config.ts";
import { readProjectBySlug } from "../../project-directory.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { buildDurableObjectProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { integrationStreamStub, readAllStreamEvents } from "../integrations/integration-streams.ts";
import { EmailProcessorContract } from "./email-processor-contract.ts";
import {
  EMAIL_BODY_TRUNCATE_CHARS,
  EMAIL_INTEGRATION_STREAM_PATH,
  EMAIL_MAX_RAW_SIZE_BYTES,
  EMAIL_RECEIVED_EVENT_TYPE,
  EMAIL_REJECTED_EVENT_TYPE,
  EMAIL_SENDER_DIRECTORY_STREAM_PATH,
  ZERO_ONBOARDING_LOCAL_PART,
  dmarcPasses,
  fallbackInboundMessageKey,
  foldEmailSenderDirectory,
  normalizeEmailAddress,
  normalizeMessageId,
  parseInboundRecipient,
  parseMessageIdList,
  senderMatchesAllowlist,
  verifySenderAlignment,
} from "./utils.ts";
import { resolveSenderProject } from "./zero-onboarding.ts";

/**
 * The structural subset of ForwardableEmailMessage the door needs — the
 * admin-gated inject route (email-inject-api.ts) fakes this shape from
 * `{envelopeFrom, envelopeTo, rawMime}`, so everything past stream draining
 * is identical (and e2e-covered) for real and synthetic deliveries.
 */
export type InboundEmailDelivery = {
  /** Envelope MAIL FROM. */
  from: string;
  /** Envelope RCPT TO. */
  to: string;
  raw: ReadableStream<Uint8Array> | string;
  rawSize: number;
  setReject(reason: string): void;
};

export type InboundEmailResult =
  | { outcome: "accepted"; projectId: string; provisioned: boolean }
  | { outcome: "rejected"; reason: string }
  | { outcome: "dropped"; reason: string };

export async function handleInboundEmail(
  message: InboundEmailDelivery,
  ctx: ExecutionContext,
): Promise<InboundEmailResult> {
  const config = parseConfig(itxEnv);

  const recipient = parseInboundRecipient(message.to);
  // Only the FIRST hostname base — the same one every outbound From/Reply-To
  // is built from (EmailRpcTarget senderIdentity) — accepts inbound mail, so
  // a thread's reply address always lives on the domain the mail arrived on.
  if (recipient === null || recipient.domain !== config.projectHostnameBases[0]) {
    message.setReject("No such address.");
    return { outcome: "rejected", reason: "no-such-address" };
  }

  if (message.rawSize > EMAIL_MAX_RAW_SIZE_BYTES) {
    message.setReject("Message too large.");
    return { outcome: "rejected", reason: "message-too-large" };
  }

  const parsed = await PostalMime.parse(message.raw);
  const fromAddress = mailboxAddress(parsed.from) ?? message.from;
  const authenticationResults = parsed.headers
    .filter((header) => header.key === "authentication-results")
    .map((header) => header.value);

  const resolved =
    recipient.slug === ZERO_ONBOARDING_LOCAL_PART
      ? await resolveZeroOnboardingProject({ config, ctx, fromAddress, authenticationResults })
      : await resolveProjectInboxDelivery({
          config,
          recipient,
          fromAddress,
          authenticationResults,
          envelope: { from: message.from, to: message.to },
        });
  if (resolved.outcome === "dropped") {
    // Accept-and-drop: no bounce, no provisioning — answering unverified mail
    // in any form would make this door an oracle for spoofed senders.
    console.warn(`[email-ingress] dropped: ${resolved.reason}`, { to: message.to });
    return resolved;
  }
  if (resolved.outcome === "rejected") {
    message.setReject(resolved.rejectMessage);
    return { outcome: "rejected", reason: resolved.reason };
  }
  const project = resolved.project;

  // Message identity for dedupe: the Message-ID when present, else a stable
  // content hash — never a random value, or every MTA retry of the same
  // message would append a fresh event and spawn a duplicate thread/agent.
  const messageKey =
    normalizeMessageId(parsed.messageId) ??
    (await fallbackInboundMessageKey({
      envelopeFrom: message.from,
      date: parsed.date,
      subject: parsed.subject,
      body: parsed.text ?? parsed.html,
    }));

  const receivedEvent = {
    type: EMAIL_RECEIVED_EVENT_TYPE,
    // The recipient is part of the key: one message delivered to two of the
    // project's addresses (To + Cc'd thread tag) is two routing decisions.
    idempotencyKey: `email-received:${messageKey}:${message.to.toLowerCase()}`,
    payload: {
      envelope: { from: message.from, to: message.to },
      // Zero-onboarding mail carries the PROVISIONED project's slug (its
      // recipient identity for loop guards and replies), never "bot".
      recipient: { slug: project.slug, threadId: recipient.threadId },
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
  return { outcome: "accepted", projectId: project.id, provisioned: resolved.provisioned };
}

type ResolvedDelivery =
  | { outcome: "accepted"; project: { id: string; slug: string }; provisioned: boolean }
  | { outcome: "rejected"; reason: string; rejectMessage: string }
  | { outcome: "dropped"; reason: string };

/**
 * The zero-onboarding lane: strict, UNCONDITIONAL sender verification (tests
 * craft a passing Authentication-Results header through the inject route
 * instead of an off switch), then resolve-or-provision by sender. The
 * enablement flag gates NEW provisioning only — a sender already claimed in
 * the directory keeps working if the flag is later turned off.
 */
async function resolveZeroOnboardingProject(input: {
  config: ReturnType<typeof parseConfig>;
  ctx: ExecutionContext;
  fromAddress: string;
  authenticationResults: string[];
}): Promise<ResolvedDelivery> {
  const fromAddress = normalizeEmailAddress(input.fromAddress);
  const atIndex = fromAddress.lastIndexOf("@");
  if (atIndex <= 0) return { outcome: "dropped", reason: "missing-from-address" };

  const verification = verifySenderAlignment({
    authenticationResults: input.authenticationResults,
    fromDomain: fromAddress.slice(atIndex + 1),
  });
  if (!verification.verified) {
    return { outcome: "dropped", reason: `sender-not-verified: ${verification.reason}` };
  }

  const resolved = await resolveSenderProject({
    config: input.config,
    ctx: input.ctx,
    address: fromAddress,
    name: undefined,
    allowProvision: input.config.email.zeroOnboardingEnabled,
  });
  if (resolved === null) {
    return {
      outcome: "rejected",
      reason: "zero-onboarding-disabled",
      rejectMessage: "No such address.",
    };
  }
  return {
    outcome: "accepted",
    project: { id: resolved.projectId, slug: resolved.slug },
    provisioned: resolved.provisioned,
  };
}

/**
 * The project-inbox lane: allowlist + DMARC (the #1711 policy, unchanged),
 * with one addition — the project's own claimed zero-onboarding sender
 * bypasses the allowlist under strict verification, so thread replies to
 * `<slug>+t<id>@` keep working for senders no allowlist knows about.
 */
async function resolveProjectInboxDelivery(input: {
  config: ReturnType<typeof parseConfig>;
  recipient: { slug: string; threadId: string | null };
  fromAddress: string;
  authenticationResults: string[];
  envelope: { from: string; to: string };
}): Promise<ResolvedDelivery> {
  const { config, recipient, fromAddress } = input;
  const project = await readProjectBySlug(config, itxEnv.PROJECT_DIRECTORY, recipient.slug);
  if (project === null) {
    return { outcome: "rejected", reason: "no-such-address", rejectMessage: "No such address." };
  }

  const rejectUnauthorized = async (reason: string): Promise<ResolvedDelivery> => {
    // Envelope-sized audit fact — the project can see someone knocked, but
    // rejected bodies are never stored.
    await integrationStreamStub(project.id, EMAIL_INTEGRATION_STREAM_PATH).append({
      type: EMAIL_REJECTED_EVENT_TYPE,
      idempotencyKey: `email-rejected:${crypto.randomUUID()}`,
      payload: { envelope: input.envelope, projectId: project.id, reason },
    });
    return {
      outcome: "rejected",
      reason,
      rejectMessage: "Sender not authorized for this address.",
    };
  };

  // The sender policy: allowlisted AND DMARC-authenticated. Matching the From
  // header against the allowlist authenticates nothing by itself — anyone can
  // write any From — so a DMARC pass from Cloudflare's inbound MX is required
  // unless the deployment explicitly opts out (local dev, tests).
  const combinedAuthenticationResults =
    input.authenticationResults.length === 0 ? null : input.authenticationResults.join(", ");
  if (senderMatchesAllowlist({ address: fromAddress, patterns: config.email.allowedSenders })) {
    if (config.email.requireDmarc && !dmarcPasses(combinedAuthenticationResults)) {
      return await rejectUnauthorized("dmarc-fail");
    }
    return { outcome: "accepted", project, provisioned: false };
  }

  // Not allowlisted: the one exception is this project's own claimed
  // zero-onboarding sender, under the strict aligned check (never the
  // requireDmarc opt-out — there is no allowlist in front of it here).
  const address = normalizeEmailAddress(fromAddress);
  const atIndex = address.lastIndexOf("@");
  if (atIndex > 0) {
    const claims = foldEmailSenderDirectory(
      await readAllStreamEvents(null, EMAIL_SENDER_DIRECTORY_STREAM_PATH),
    );
    if (claims.get(address) === project.id) {
      const verification = verifySenderAlignment({
        authenticationResults: input.authenticationResults,
        fromDomain: address.slice(atIndex + 1),
      });
      if (verification.verified) return { outcome: "accepted", project, provisioned: false };
      return { outcome: "dropped", reason: `sender-not-verified: ${verification.reason}` };
    }
  }

  return await rejectUnauthorized("sender-not-allowed");
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
