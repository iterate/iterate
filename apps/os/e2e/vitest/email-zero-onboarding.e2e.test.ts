// Email zero-onboarding end-to-end smoke (tasks/email-agent-zero-onboarding.md):
// synthetic inbound email -> admin-gated inject route (the same
// handleInboundEmail the real email() entrypoint runs) -> sender verification
// -> auto-provisioned user/org/project -> email router (thread t<offset>) ->
// email-agent transcription -> LLM -> itx.email.reply attempt, observable as
// an email/sent (or, where the domain is not onboarded for Email Sending,
// email/send-failed) audit event. Thread continuation rides the +t Reply-To
// token through the project-inbox lane, whose per-project allowlist was
// seeded with the provisioned sender at project birth. We stop at the
// outbound attempt.
//
// Senders use the reserved non-deliverable `.test` TLD on purpose: if a reply
// send DOES fire for real, nothing leaves the building. Sender verification
// is crafted into the injected Authentication-Results header — the inject
// route's admin secret IS the trust bypass. No cleanup, matching
// create-test-project.ts's documented no-op convention.

import { expect, test } from "vitest";
import type { StreamEvent } from "../../src/types.ts";
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
  reason?: string;
  rejectMessage?: string;
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

    using session = withItxSession();
    using root = session.authenticate({ type: "admin-secret", secret: adminSecret() });

    // --- Unverified mail must be dropped (accepted-and-discarded, no bounce)
    // with no provisioning side effects.
    const spoofed = await injectEmail({
      from: sender,
      to: botAddress,
      subject: "spoofed",
      body: "no Authentication-Results header at all",
      messageId: `e2e-spoof-${RUN_SUFFIX}@example.test`,
      authenticationResults: null,
    });
    expect(spoofed).toMatchObject({ outcome: "dropped" });
    expect(spoofed.reason).toMatch(/sender-not-verified/);
    expect(spoofed.rejectMessage).toBeUndefined();

    // --- The real thing: Joe Bloggs emails the bot.
    const accepted = await injectEmail({
      from: sender,
      fromName: "Joe Bloggs",
      to: botAddress,
      subject: "quick greeting",
      body: [
        "Hi! Please reply to this email with a one-sentence greeting.",
        "(This is an automated end-to-end test of the zero-onboarding email agent.)",
      ].join("\n"),
      messageId: `e2e-root-${RUN_SUFFIX}@example.test`,
    });
    expect(accepted).toMatchObject({ outcome: "accepted", provisioned: true });
    const projectId = accepted.projectId!;
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

    // --- Router: email/received lands on /integrations/email and a thread
    // route is minted; capture the thread id, agent path, and the provisioned
    // project's slug (the received event's recipient identity).
    using project = root.projects.get(projectId);
    using integrationStream = project.streams.get("/integrations/email");
    const integrationEvents = await waitFor(
      () => integrationStream.getEvents({ afterOffset: 0 }),
      (events) =>
        events.some((event) => event.type === "events.iterate.com/email/received") &&
        events.some((event) => event.type === "events.iterate.com/email/thread-route-configured"),
      () => "email/received + thread route on /integrations/email",
    );
    const received = integrationEvents.find(
      (event) => event.type === "events.iterate.com/email/received",
    )!;
    const slug = (received.payload as { recipient: { slug: string } }).recipient.slug;
    expect(slug).not.toBe("bot");
    const route = integrationEvents.find(
      (event) => event.type === "events.iterate.com/email/thread-route-configured",
    )!;
    const { threadId, streamPath: agentStreamPath } = route.payload as {
      threadId: string;
      streamPath: string;
    };
    expect(agentStreamPath).toBe(`/agents/email/t${threadId}`);

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

    // --- LLM reply: codemode script using itx.email.reply (the email prompt's
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
        ((event.payload as { code?: string }).code ?? "").includes("email.reply"),
      ),
    ).toBe(true);

    // --- Outbound attempt: itx.email.reply appends an audit fact whether the
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

    // --- Thread continuation: Joe replies to the thread's +t Reply-To
    // address. That rides the project-inbox lane — no DEPLOYMENT allowlist
    // knows this sender, so this exercises the per-project allowlist that
    // provisioning seeded with Joe's address — and the +t token routes it to
    // the SAME agent stream with no new provisioning.
    const continuation = await injectEmail({
      from: sender,
      fromName: "Joe Bloggs",
      to: `${slug}+t${threadId}@${emailDomain()}`,
      subject: "Re: quick greeting",
      body: "Thanks! One more sentence please.",
      messageId: `e2e-reply-${RUN_SUFFIX}@example.test`,
    });
    expect(continuation).toMatchObject({ outcome: "accepted", projectId, provisioned: false });
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
  expect(first).toMatchObject({ outcome: "accepted", provisioned: true });

  const second = await injectEmail({
    from: sender,
    to: botAddress,
    subject: "second contact (new thread)",
    body: "hello again",
    messageId: `e2e-idem-2-${RUN_SUFFIX}@example.test`,
  });
  expect(second).toMatchObject({
    outcome: "accepted",
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
