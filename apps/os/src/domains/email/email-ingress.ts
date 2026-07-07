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
//   deployment sender allowlist + the project's own allowlist (seeded with
//   the creator's email at birth — for zero-onboarding projects that is the
//   provisioned sender, which is how thread replies to `<slug>+t<id>@` keep
//   working for senders no deployment allowlist knows) + DMARC.
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
import { integrationStreamStub } from "../integrations/integration-streams.ts";
import { EmailProcessorContract } from "./email-processor-contract.ts";
import {
  EMAIL_BODY_TRUNCATE_CHARS,
  EMAIL_INTEGRATION_STREAM_PATH,
  EMAIL_MAX_RAW_SIZE_BYTES,
  EMAIL_RECEIVED_EVENT_TYPE,
  EMAIL_REJECTED_EVENT_TYPE,
  ZERO_ONBOARDING_LOCAL_PART,
  dmarcPasses,
  emailDomainForDeployment,
  fallbackInboundMessageKey,
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
type InboundEmailDelivery = {
  /** Envelope MAIL FROM. */
  from: string;
  /** Envelope RCPT TO. */
  to: string;
  raw: ReadableStream<Uint8Array> | string;
  rawSize: number;
  setReject(reason: string): void;
};

type InboundEmailResult =
  | { outcome: "accepted"; projectId: string; provisioned: boolean }
  | { outcome: "rejected"; reason: string }
  | { outcome: "dropped"; reason: string };

export async function handleInboundEmail(
  message: InboundEmailDelivery,
  ctx: ExecutionContext,
): Promise<InboundEmailResult> {
  const config = parseConfig(itxEnv);

  const recipient = parseInboundRecipient(message.to);
  // Only the deployment's email domain — the same normalized first hostname
  // base every outbound From/Reply-To is built from (EmailRpcTarget
  // senderIdentity) — accepts inbound mail, so a thread's reply address
  // always lives on the domain the mail arrived on.
  const emailDomain = emailDomainForDeployment(config.projectHostnameBases);
  if (recipient === null || emailDomain === null || recipient.domain !== emailDomain) {
    message.setReject("No such address.");
    return { outcome: "rejected", reason: "no-such-address" };
  }

  // Pre-parse for memory safety, which also means no email/rejected audit
  // fact for oversize mail — the addressed project is not resolved yet.
  if (message.rawSize > EMAIL_MAX_RAW_SIZE_BYTES) {
    message.setReject("Message too large.");
    return { outcome: "rejected", reason: "message-too-large" };
  }

  const parsed = await PostalMime.parse(message.raw);
  const fromAddress = mailboxAddress(parsed.from) ?? message.from;
  const authenticationResults = parsed.headers
    .filter((header) => header.key === "authentication-results")
    .map((header) => header.value);

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

  const resolved =
    recipient.slug === ZERO_ONBOARDING_LOCAL_PART
      ? await resolveZeroOnboardingProject({ config, ctx, fromAddress, authenticationResults })
      : await resolveProjectInboxDelivery({
          config,
          recipient,
          fromAddress,
          authenticationResults,
          envelope: { from: message.from, to: message.to },
          messageKey,
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
 * the directory keeps working if the flag is later turned off. Provisioning
 * seeds the new project's own sender allowlist with this sender (the
 * creator), so thread replies to `<slug>+t<id>@` pass the project-inbox lane
 * below without any deployment allowlist entry.
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
 * The project-inbox lane: allowlisted AND DMARC-authenticated. Matching the
 * From header against the allowlist authenticates nothing by itself — anyone
 * can write any From — so a DMARC pass from Cloudflare's inbound MX is
 * required unless the deployment explicitly opts out (local dev, tests). The
 * allowlist is the deployment-wide config plus the project's own patterns
 * (seeded with the creator's email at project birth — the provisioned sender
 * for zero-onboarding projects).
 */
async function resolveProjectInboxDelivery(input: {
  config: ReturnType<typeof parseConfig>;
  recipient: { slug: string; threadId: string | null };
  fromAddress: string;
  authenticationResults: string[];
  envelope: { from: string; to: string };
  messageKey: string;
}): Promise<ResolvedDelivery> {
  const { config, recipient, fromAddress } = input;
  const project = await readProjectBySlug(config, itxEnv.PROJECT_DIRECTORY, recipient.slug);
  if (project === null) {
    return { outcome: "rejected", reason: "no-such-address", rejectMessage: "No such address." };
  }

  const rejectUnauthorized = async (reason: string): Promise<ResolvedDelivery> => {
    // Envelope-sized audit fact — the project can see someone knocked, but
    // rejected bodies are never stored. Deterministic key, same rationale as
    // the received-mail key: a redelivery of the same message (worker crash
    // between append and setReject) must dedupe, not double-append.
    await integrationStreamStub(project.id, EMAIL_INTEGRATION_STREAM_PATH).append({
      type: EMAIL_REJECTED_EVENT_TYPE,
      idempotencyKey: `email-rejected:${input.messageKey}:${input.envelope.to.toLowerCase()}:${reason}`,
      payload: { envelope: input.envelope, projectId: project.id, reason },
    });
    return {
      outcome: "rejected",
      reason,
      rejectMessage: "Sender not authorized for this address.",
    };
  };

  const projectPatterns = await readProjectAllowedSenders(project.id);
  const patterns = [...config.email.allowedSenders, ...projectPatterns];
  if (!senderMatchesAllowlist({ address: fromAddress, patterns })) {
    return await rejectUnauthorized("sender-not-allowed");
  }
  const combinedAuthenticationResults =
    input.authenticationResults.length === 0 ? null : input.authenticationResults.join(", ");
  if (config.email.requireDmarc && !dmarcPasses(combinedAuthenticationResults)) {
    return await rejectUnauthorized("dmarc-fail");
  }
  return { outcome: "accepted", project, provisioned: false };
}

/**
 * The project's own sender allowlist: the email router's reduced
 * `allowedSenders` (seeded with the creator's email at project birth, grown
 * by `email/sender-allowed` events). Read failures degrade to [] — the
 * deployment-wide config allowlist still applies and closed-by-default holds.
 */
async function readProjectAllowedSenders(projectId: string): Promise<string[]> {
  try {
    const project = itxEnv.PROJECT.getByName(
      DurableObjectNameCodec.stringify({ projectId, path: EMAIL_INTEGRATION_STREAM_PATH }),
    );
    const { state } = await (await project.emailProcessor).snapshot();
    const allowedSenders = (state as { allowedSenders?: unknown }).allowedSenders;
    return Array.isArray(allowedSenders)
      ? allowedSenders.filter((pattern): pattern is string => typeof pattern === "string")
      : [];
  } catch (error) {
    console.error("[email] failed to read project sender allowlist", { error, projectId });
    return [];
  }
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
