// Email zero-onboarding end-to-end smoke (tasks/email-agent-zero-onboarding.md):
// synthetic inbound email -> admin-gated inject route (the same
// handleInboundEmail the real email() entrypoint runs) -> sender verification
// -> auto-provisioned user/org/project -> email router processor -> routed
// email-thread agent stream -> email-agent transcription -> LLM -> codemode
// reply whose itx.email.send attempt lands an email/sent (or, on deployments
// whose domain is not onboarded for Email Sending, email/send-failed) audit
// event on /integrations/email. We stop at the outbound attempt.
//
// Senders use the reserved non-deliverable `.test` TLD on purpose: if a reply
// send DOES fire for real, nothing leaves the building. Sender verification
// is crafted into the injected Authentication-Results header — the inject
// route's admin secret IS the trust bypass. No cleanup, matching
// create-test-project.ts's documented no-op convention.

import { expect, test } from "vitest";
import type { StreamEvent } from "../../src/types.ts";
import { emailThreadStreamPath } from "../../src/domains/email/utils.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { adminSecret, buildUrl, withItxSession } from "./test-helpers.ts";

const RUN_SUFFIX = crypto.randomUUID().slice(0, 8);
const EMAIL_SENDER_DIRECTORY_STREAM_PATH = "/integrations/email-sender-directory";

async function injectEmail(input: {
  from: string;
  fromName?: string;
  to: string;
  subject: string;
  body: string;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  authenticationResults?: string | null;
}): Promise<{
  outcome: string;
  projectId?: string;
  provisioned?: boolean;
  messageId?: string;
  reason?: string;
}> {
  const fromDomain = input.from.slice(input.from.lastIndexOf("@") + 1);
  const authenticationResults =
    input.authenticationResults === undefined
      ? `mx.cloudflare.net; spf=pass; dkim=pass header.d=${fromDomain}; dmarc=pass header.from=${fromDomain}`
      : input.authenticationResults;
  const rawMime = [
    `From: ${input.fromName ? `${input.fromName} <${input.from}>` : input.from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    `Message-ID: <${input.messageId}>`,
    ...(input.inReplyTo ? [`In-Reply-To: <${input.inReplyTo}>`] : []),
    ...(input.references
      ? [`References: ${input.references.map((reference) => `<${reference}>`).join(" ")}`]
      : []),
    ...(authenticationResults === null ? [] : [`Authentication-Results: ${authenticationResults}`]),
    "Content-Type: text/plain; charset=utf-8",
    "",
    input.body,
    "",
  ].join("\r\n");

  const response = await fetch(buildUrl({ path: "/api/integrations/email/inject" }), {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminSecret()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ envelopeFrom: input.from, envelopeTo: input.to, rawMime }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Awaited<ReturnType<typeof injectEmail>>;
}

/** The deployment's email domain: derived the same way outbound send derives it. */
function emailDomain(): string {
  const raw = process.env.APP_CONFIG_PROJECT_HOSTNAME_BASES?.trim();
  if (!raw) {
    throw new Error("email e2e needs APP_CONFIG_PROJECT_HOSTNAME_BASES (run under doppler).");
  }
  const bases = JSON.parse(raw) as string[];
  if (!bases[0]) throw new Error("APP_CONFIG_PROJECT_HOSTNAME_BASES is empty.");
  return bases[0];
}

async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  message: () => string,
  timeoutMs = 60_000,
): Promise<T> {
  let last: T | undefined;
  await waitForCondition(
    async () => {
      last = await read();
      return predicate(last);
    },
    {
      description: () => `${message()}; last=${JSON.stringify(last)}`,
      intervalMs: 1_000,
      timeoutMs,
    },
  );
  return last as T;
}

test(
  "inbound email to bot@ provisions a project and routes to an email agent that attempts a reply",
  { timeout: 240_000 },
  async () => {
    const sender = `zero-onboarding-${RUN_SUFFIX}@example.test`;
    const botAddress = `bot@${emailDomain()}`;
    const rootMessageId = `e2e-root-${RUN_SUFFIX}@example.test`;
    const agentStreamPath = emailThreadStreamPath(rootMessageId);

    using session = withItxSession();
    using root = session.authenticate({ type: "admin-secret", secret: adminSecret() });

    // --- Unverified mail must be dropped with no provisioning side effects.
    const spoofed = await injectEmail({
      from: sender,
      to: botAddress,
      subject: "spoofed",
      body: "no Authentication-Results header at all",
      messageId: `e2e-spoof-${RUN_SUFFIX}@example.test`,
      authenticationResults: null,
    });
    expect(spoofed).toMatchObject({ outcome: "dropped", reason: "sender-not-verified" });

    // --- The real thing: Joe Bloggs emails the bot.
    const routed = await injectEmail({
      from: sender,
      fromName: "Joe Bloggs",
      to: botAddress,
      subject: "tiny web page",
      body: [
        "Hi! Please reply to this email with a one-sentence greeting.",
        "(This is an automated end-to-end test of the zero-onboarding email agent.)",
      ].join("\n"),
      messageId: rootMessageId,
    });
    expect(routed).toMatchObject({ outcome: "routed", provisioned: true });
    const projectId = routed.projectId!;
    expect(projectId).toMatch(/^prj_/);

    // --- The sender claim is in the deployment-wide directory.
    using directory = root.streams.get(EMAIL_SENDER_DIRECTORY_STREAM_PATH);
    const claims = await directory.getEvents({ afterOffset: 0 });
    expect(
      claims.filter(
        (event) =>
          event.type === "events.iterate.com/email/sender-claimed" &&
          (event.payload as { address?: string }).address === sender,
      ),
    ).toHaveLength(1);

    // --- Router: email/received lands on /integrations/email and the thread
    // route points at the message's thread agent stream.
    using project = root.projects.get(projectId);
    using integrationStream = project.streams.get("/integrations/email");
    await waitFor(
      () => integrationStream.getEvents({ afterOffset: 0 }),
      (events) =>
        events.some((event) => event.type === "events.iterate.com/email/received") &&
        events.some(
          (event) =>
            event.type === "events.iterate.com/email/thread-route-configured" &&
            (event.payload as { streamPath?: string }).streamPath === agentStreamPath,
        ),
      () => "email/received + thread route on /integrations/email",
    );

    using agentStream = project.streams.get(agentStreamPath);
    const hasEvent = (events: StreamEvent[], type: string) =>
      events.some((event) => event.type === type);

    // --- email-agent: mail transcribed into triggering agent input, and the
    // agent processor schedules + requests LLM work for it.
    await waitFor(
      () => agentStream.getEvents({ afterOffset: 0 }),
      (events) =>
        hasEvent(events, "events.iterate.com/email/received") &&
        hasEvent(events, "events.iterate.com/agent/input-added") &&
        hasEvent(events, "events.iterate.com/agent/llm-request-requested"),
      () => `agent input + llm request on ${agentStreamPath}`,
      120_000,
    );

    // --- LLM reply: codemode script using itx.email.send (the email prompt's
    // reply door).
    const withScript = await waitFor(
      () => agentStream.getEvents({ afterOffset: 0 }),
      (events) => hasEvent(events, "events.iterate.com/capability-host/script-execution-requested"),
      () => `itx script execution on ${agentStreamPath}`,
      120_000,
    );
    const scripts = withScript.filter(
      (event) => event.type === "events.iterate.com/capability-host/script-execution-requested",
    );
    expect(
      scripts.some((event) =>
        ((event.payload as { code?: string }).code ?? "").includes("email.send"),
      ),
    ).toBe(true);

    // --- Outbound attempt: itx.email.send appends an audit fact whether the
    // EMAIL binding accepted the message (email/sent) or the deployment's
    // domain is not onboarded for sending yet (email/send-failed). Either way
    // the reply attempt is observable; `.test` recipients cannot receive mail.
    await waitFor(
      () => integrationStream.getEvents({ afterOffset: 0 }),
      (events) =>
        events.some(
          (event) =>
            event.type === "events.iterate.com/email/sent" ||
            event.type === "events.iterate.com/email/send-failed",
        ),
      () => "outbound reply attempt (email/sent or email/send-failed)",
      120_000,
    );

    // --- Thread continuation: Joe replies in the same thread; it must land on
    // the SAME agent stream as a second input, with no new provisioning.
    const reply = await injectEmail({
      from: sender,
      fromName: "Joe Bloggs",
      to: botAddress,
      subject: "Re: tiny web page",
      body: "Thanks! One more sentence please.",
      messageId: `e2e-reply-${RUN_SUFFIX}@example.test`,
      inReplyTo: rootMessageId,
      references: [rootMessageId],
    });
    expect(reply).toMatchObject({ outcome: "routed", projectId, provisioned: false });
    await waitFor(
      () => agentStream.getEvents({ afterOffset: 0 }),
      (events) =>
        events.filter((event) => event.type === "events.iterate.com/email/received").length >= 2,
      () => `thread continuation lands on ${agentStreamPath}`,
      60_000,
    );
  },
);

test("a second email from the same sender reuses the same project (idempotent provisioning)", async () => {
  const sender = `zero-onboarding-idem-${RUN_SUFFIX}@example.test`;
  const botAddress = `bot@${emailDomain()}`;

  const first = await injectEmail({
    from: sender,
    to: botAddress,
    subject: "first contact",
    body: "hello",
    messageId: `e2e-idem-1-${RUN_SUFFIX}@example.test`,
  });
  expect(first).toMatchObject({ outcome: "routed", provisioned: true });

  const second = await injectEmail({
    from: sender,
    to: botAddress,
    subject: "second contact (new thread)",
    body: "hello again",
    messageId: `e2e-idem-2-${RUN_SUFFIX}@example.test`,
  });
  expect(second).toMatchObject({
    outcome: "routed",
    projectId: first.projectId,
    provisioned: false,
  });

  // Exactly one sender claim, and exactly one user/org/project behind it.
  using session = withItxSession();
  using root = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using directory = root.streams.get(EMAIL_SENDER_DIRECTORY_STREAM_PATH);
  const claims = await directory.getEvents({ afterOffset: 0 });
  expect(
    claims.filter(
      (event) =>
        event.type === "events.iterate.com/email/sender-claimed" &&
        (event.payload as { address?: string }).address === sender,
    ),
  ).toHaveLength(1);
});
