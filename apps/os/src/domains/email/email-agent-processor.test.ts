// The email-agent facet's executable spec, on the generic step harness from
// iterate/processors/testing: the REAL StreamProcessorRunner over the shared
// MemoryStream (production idempotency semantics: a same-key append with a
// different body is REJECTED). Scenarios are ordered steps — typed appends
// plus function steps driving the attachment-resolution fake (the only
// email-agent-specific dependency). The registry-level eviction recovery
// suite lives separately in email-agent-recovery.test.ts.

import { describe, expect, it } from "vitest";
import type { ConsumedInput } from "iterate/processors";
import {
  makeMemoryProgressStore,
  makeProcessorHarness,
  type HarnessSubstrate,
} from "iterate/processors/testing";
import {
  EmailAgentProcessor,
  type EmailAgentDeps,
} from "./email-agent-processor-implementation.ts";
import { EmailAgentProcessorContract } from "./email-agent-processor-contract.ts";
import type { InboundEmailPayload } from "./email-processor-contract.ts";

// -----------------------------------------------------------------------------
// Event literals: the facet's birth and the recurring inbound-mail payload.
// These are event BUILDERS (data), not append wrappers — every test appends
// through the harness's typed append.
// -----------------------------------------------------------------------------

const EMAIL_AGENT_BORN = {
  type: "events.iterate.com/email-agent/created",
  payload: { config: { threadId: "1" } },
} satisfies ConsumedInput<EmailAgentProcessorContract>;

function receivedPayload(input: {
  from?: string;
  subject?: string;
  text?: string;
  automated?: boolean;
  attachments?: InboundEmailPayload["message"]["attachments"];
  replyToAddress?: string | null;
  fromMailbox?: InboundEmailPayload["message"]["from"];
}): InboundEmailPayload {
  return {
    envelope: { from: input.from ?? "jonas@example.com", to: "acme@iterate.app" },
    recipient: { slug: "acme", threadId: null },
    projectId: "prj_1",
    automated: input.automated ?? false,
    message: {
      messageId: "msg-1@mail.example",
      inReplyTo: null,
      references: [],
      from: input.fromMailbox ?? { address: input.from ?? "jonas@example.com", name: "Jonas" },
      replyToAddress: input.replyToAddress ?? null,
      subject: input.subject ?? "Hello agent",
      text: input.text ?? "Can you help me with something?",
      attachments: input.attachments ?? [],
    },
  };
}

/** The generic harness plus the facet's attachment-resolution fake, wired in
 * createProcessor. Pass another harness's substrate (with a fresh progress
 * store) to replay the same stream from offset zero. */
function makeEmailAgentHarness(input?: {
  resolveStoredAttachments?: EmailAgentDeps["resolveStoredAttachments"];
  substrate?: HarnessSubstrate;
}) {
  return makeProcessorHarness<EmailAgentProcessorContract>({
    createProcessor: (deps) =>
      new EmailAgentProcessor({
        stream: deps.stream,
        path: deps.path,
        projectId: null,
        ...(input?.resolveStoredAttachments === undefined
          ? {}
          : { resolveStoredAttachments: input.resolveStoredAttachments }),
      }),
    path: "/agents/email/t1",
    ...(input?.substrate === undefined ? {} : { substrate: input.substrate }),
  });
}

describe("EmailAgentProcessor", () => {
  it("ignores a second email-agent birth certificate during reduction", async () => {
    const h = makeEmailAgentHarness();
    await h.play(["append", EMAIL_AGENT_BORN]);
    await h.append(EMAIL_AGENT_BORN);
    expect(h.state().birthCertificate).toEqual(EMAIL_AGENT_BORN.payload);
  });

  it("captures thread context and transcribes inbound mail into triggering agent context", async () => {
    const h = makeEmailAgentHarness();
    await h.play([
      "append",
      EMAIL_AGENT_BORN,
      {
        type: "events.iterate.com/email/thread-route-configured",
        payload: {
          threadId: "1",
          streamPath: "/agents/email/t1",
          counterpart: "jonas@example.com",
          subject: "Hello agent",
        },
      },
      { type: "events.iterate.com/email/received", payload: receivedPayload({}) },
    ]);

    const inputs = h.events("events.iterate.com/agents/context-added");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).toMatchObject({
      role: "developer",
      actor: { type: "email", address: "jonas@example.com", name: "Jonas" },
      refs: [
        {
          type: "event",
          streamPath: "/agents/email/t1",
          offset: 3,
          eventType: "events.iterate.com/email/received",
        },
      ],
    });
    const payload = inputs[0]!.payload;
    expect(payload.content).toContain("email/received");
    expect(payload.content).toContain("jonas@example.com");
    expect(payload.content).toContain("Can you help me with something?");
    // The contract default (triggering) policy applies to human mail.
    expect(payload.llmRequestPolicy).toEqual({ behaviour: "after-current-request" });

    expect(h.state()).toMatchObject({
      threadId: "1",
      streamPath: "/agents/email/t1",
      counterpart: "jonas@example.com",
      subject: "Hello agent",
    });
  });

  it("refreshes the agent's presence binding when the thread identity changes, and only then", async () => {
    const h = makeEmailAgentHarness();
    await h.play(["append", EMAIL_AGENT_BORN]); // birth alone never appends a binding
    expect(h.events("events.iterate.com/agent/binding-set")).toHaveLength(0);

    await h.play([
      "append",
      {
        type: "events.iterate.com/email/thread-route-configured",
        payload: {
          threadId: "1",
          streamPath: "/agents/email/t1",
          counterpart: "jonas@example.com",
          subject: "Hello agent",
        },
      },
    ]);
    expect(h.events("events.iterate.com/agent/binding-set")).toMatchObject([
      {
        payload: {
          type: "email_thread",
          threadId: "1",
          counterpart: "jonas@example.com",
          subject: "Hello agent",
        },
      },
    ]);

    // The same identity again: no refresh.
    await h.play([
      "append",
      {
        type: "events.iterate.com/email/thread-route-configured",
        payload: {
          threadId: "1",
          streamPath: "/agents/email/t1",
          counterpart: "jonas@example.com",
          subject: "Hello agent",
        },
      },
    ]);
    expect(h.events("events.iterate.com/agent/binding-set")).toHaveLength(1);

    // Mail with a new subject moves the identity → a second refresh.
    await h.play([
      "append",
      {
        type: "events.iterate.com/email/received",
        payload: receivedPayload({ subject: "New topic" }),
      },
    ]);
    expect(h.events("events.iterate.com/agent/binding-set")).toMatchObject([
      { payload: { subject: "Hello agent" } },
      { payload: { subject: "New topic", counterpart: "jonas@example.com" } },
    ]);
  });

  it("attaches door-stored attachments to the agent context item as files", async () => {
    const resolved = {
      contentType: "application/pdf",
      filename: "report.pdf",
      path: "/email/inbound/msg-0-report.pdf",
      size: 1234,
      url: "https://iterate-files--acme.iterate.app/report.pdf?sig=x",
    };
    const seen: unknown[] = [];
    const h = makeEmailAgentHarness({
      resolveStoredAttachments: async (attachments) => {
        seen.push(attachments);
        return [resolved];
      },
    });

    await h.play([
      "append",
      EMAIL_AGENT_BORN,
      {
        type: "events.iterate.com/email/received",
        payload: receivedPayload({
          attachments: [
            {
              filename: "report.pdf",
              mimeType: "application/pdf",
              size: 1234,
              path: "/email/inbound/msg-0-report.pdf",
            },
            // Metadata-only attachment (storage failed at the door): not resolved.
            { filename: "broken.bin", mimeType: null, size: 10 },
          ],
        }),
      },
    ]);

    expect(seen).toEqual([
      [
        {
          filename: "report.pdf",
          mimeType: "application/pdf",
          path: "/email/inbound/msg-0-report.pdf",
          size: 1234,
        },
      ],
    ]);
    const inputs = h.events("events.iterate.com/agents/context-added");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).toMatchObject({ files: [resolved] });
  });

  it("a failed attachment resolution forwards the mail with an explicit loss note", async () => {
    const h = makeEmailAgentHarness({
      resolveStoredAttachments: async () => {
        throw new Error("signing exploded");
      },
    });

    await h.play([
      "append",
      EMAIL_AGENT_BORN,
      {
        type: "events.iterate.com/email/received",
        payload: receivedPayload({
          attachments: [
            {
              filename: "cat.png",
              mimeType: "image/png",
              size: 3,
              path: "/email/inbound/msg-0-cat.png",
            },
          ],
        }),
      },
    ]);

    const inputs = h.events("events.iterate.com/agents/context-added");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).not.toHaveProperty("files");
    const content = inputs[0]!.payload.content;
    expect(content).toContain("cat.png");
    // Never a silent drop: the loss and its cause are visible to the model.
    expect(content).toContain("[1 attachment(s) could not be loaded: signing exploded]");
  });

  it("records automated mail as non-triggering input (mail-loop guard)", async () => {
    const h = makeEmailAgentHarness();
    await h.play([
      "append",
      EMAIL_AGENT_BORN,
      {
        type: "events.iterate.com/email/received",
        payload: receivedPayload({ automated: true }),
      },
    ]);

    const inputs = h.events("events.iterate.com/agents/context-added");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).toMatchObject({
      llmRequestPolicy: { behaviour: "dont-trigger-request" },
    });
  });

  it("never lets automated mail become the thread counterpart", async () => {
    const h = makeEmailAgentHarness();
    await h.play([
      "append",
      EMAIL_AGENT_BORN,
      { type: "events.iterate.com/email/received", payload: receivedPayload({}) },
      {
        type: "events.iterate.com/email/received",
        payload: receivedPayload({ automated: true, from: "mailer-daemon@example.com" }),
      },
    ]);

    // The human sender stays the counterpart even after a later bounce.
    expect(h.state().counterpart).toBe("jonas@example.com");
  });

  it("ignores the project's own mail looping back, including for counterpart state", async () => {
    const h = makeEmailAgentHarness();
    await h.play([
      "append",
      EMAIL_AGENT_BORN,
      { type: "events.iterate.com/email/received", payload: receivedPayload({}) },
      {
        type: "events.iterate.com/email/received",
        payload: receivedPayload({ from: "acme@iterate.app" }),
      },
    ]);

    expect(h.events("events.iterate.com/agents/context-added")).toHaveLength(1);
    // Our own looped-back mail never becomes the thread counterpart — the
    // human sender stays the reply target.
    expect(h.state().counterpart).toBe("jonas@example.com");
  });

  it("falls back to the envelope from when MIME parsing yields no From mailbox", async () => {
    const h = makeEmailAgentHarness();
    await h.play([
      "append",
      EMAIL_AGENT_BORN,
      {
        type: "events.iterate.com/email/received",
        payload: receivedPayload({ fromMailbox: { name: "Jonas" } }),
      },
    ]);

    // The envelope sender — the address ingress authenticated — becomes the
    // counterpart, so email.reply still has a target.
    expect(h.state().counterpart).toBe("jonas@example.com");
  });

  it("filters mail from the project's own tagged addresses as loop-back", async () => {
    const h = makeEmailAgentHarness();
    await h.play([
      "append",
      EMAIL_AGENT_BORN,
      {
        type: "events.iterate.com/email/received",
        payload: receivedPayload({ from: "acme+t42@iterate.app" }),
      },
    ]);

    expect(h.events("events.iterate.com/agents/context-added")).toHaveLength(0);
    expect(h.state().counterpart).toBeUndefined();
  });

  it("skips a Reply-To pointing back at the project itself (never mail ourselves)", async () => {
    const h = makeEmailAgentHarness();
    await h.play([
      "append",
      EMAIL_AGENT_BORN,
      {
        type: "events.iterate.com/email/received",
        payload: receivedPayload({ replyToAddress: "acme+t1@iterate.app" }),
      },
    ]);

    // The project-owned Reply-To is skipped; the human From wins.
    expect(h.state().counterpart).toBe("jonas@example.com");
  });

  it("prefers Reply-To over From as the thread counterpart", async () => {
    const h = makeEmailAgentHarness();
    await h.play([
      "append",
      EMAIL_AGENT_BORN,
      {
        type: "events.iterate.com/email/received",
        payload: receivedPayload({ replyToAddress: "replies@example.com" }),
      },
    ]);

    expect(h.state().counterpart).toBe("replies@example.com");
  });

  it("a full replay (fresh cursor over the same stream) tolerates re-minted attachment URLs", async () => {
    // The harshest at-least-once redelivery: a fresh progress store over the
    // SAME stream re-runs the blocked transcription long after the original
    // committed. Attachment re-resolution mints a DIFFERENT signed URL, so
    // the re-append is a same-key-DIFFERENT-body conflict the stream rejects
    // — the processor must treat the committed transcription as settlement
    // instead of wedging the frame forever.
    let mint = 0;
    const resolveStoredAttachments: EmailAgentDeps["resolveStoredAttachments"] = async (
      attachments,
    ) =>
      attachments.map((attachment) => ({
        contentType: attachment.mimeType ?? "application/octet-stream",
        filename: attachment.filename ?? "attachment",
        path: attachment.path,
        size: attachment.size,
        url: `https://iterate-files--acme.iterate.app${attachment.path}?sig=${mint++}`,
      }));
    const h = makeEmailAgentHarness({ resolveStoredAttachments });
    await h.play([
      "append",
      EMAIL_AGENT_BORN,
      {
        type: "events.iterate.com/email/received",
        payload: receivedPayload({
          attachments: [
            {
              filename: "report.pdf",
              mimeType: "application/pdf",
              size: 1234,
              path: "/email/inbound/msg-0-report.pdf",
            },
          ],
        }),
      },
    ]);
    expect(h.events("events.iterate.com/agents/context-added")).toHaveLength(1);
    const committedOffsets = h.events().map((row) => row.offset);

    const replay = makeEmailAgentHarness({
      resolveStoredAttachments,
      substrate: {
        clock: h.clock,
        stream: h.stream,
        progress: makeMemoryProgressStore(EmailAgentProcessorContract),
      },
    });
    await replay.settle(); // replays the whole stream; a wedge would throw here

    // The stream is byte-identical: the conflicting re-append lost the race
    // and the first transcription (first minted URL) stands.
    expect(replay.events().map((row) => row.offset)).toEqual(committedOffsets);
    const inputs = replay.events("events.iterate.com/agents/context-added");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).toMatchObject({
      files: [{ url: expect.stringContaining("sig=0") }],
    });
  });
});
