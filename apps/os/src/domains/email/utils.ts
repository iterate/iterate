// First-party outbound email (the `itx.email` capability). Pure helpers only —
// the env-touching send orchestration lives in rpc-targets.ts's EmailRpcTarget.
// Inbound routing (project/agent inboxes) is the follow-up half of
// tasks/os-agent-email-cloudflare-workers.md.

/** Stream that receives the project's email audit trail (`email/sent` events). */
export const EMAIL_INTEGRATION_STREAM_PATH = "/integrations/email";
export const EMAIL_SENT_EVENT_TYPE = "events.iterate.com/email/sent";

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
  }): Promise<unknown>;
};

/** One addressable mailbox in the Email Service structured send() shape. */
type EmailParty = {
  email: string;
  name?: string;
};

/** What `itx.email.send` accepts — see EmailCapability in types.ts for the contract docs. */
type SendProjectEmailRequest = {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  from?: string;
};

/** The project's own sending identity: `<slug>@<sender domain>`. */
export function emailAddressForProject(input: { slug: string; domain: string }): string {
  return `${input.slug}@${input.domain}`;
}

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
  return {
    from: { email: from, name: projectName },
    to: request.to,
    subject: request.subject,
    ...(request.text ? { text: request.text } : {}),
    ...(request.html ? { html: request.html } : {}),
  };
}
