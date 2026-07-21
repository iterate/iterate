// A blocking inbound-mail transcription is the message's only path to the
// agent. If the processor is evicted mid-transcription, the durable keepalive
// alarm must wake a successor and redeliver the held frame.

import { describe, expect, it } from "vitest";
import { KEEPALIVE_ALARM_LEAD_MS } from "iterate/processors";
import { makeProcessorHarness } from "iterate/processors/testing";
import type { AgentFileAttachment } from "../agents/agent-processor-contract.ts";
import { EmailAgentProcessorContract } from "./email-agent-processor-contract.ts";
import { EmailAgentProcessor } from "./email-agent-processor-implementation.ts";

const HOME = "/agents/email/t1";

function receivedPayload() {
  return {
    envelope: { from: "jonas@example.com", to: "acme@iterate.app" },
    recipient: { slug: "acme", threadId: null },
    projectId: "prj_1",
    automated: false,
    message: {
      messageId: "msg-1@mail.example",
      inReplyTo: null,
      references: [],
      from: { address: "jonas@example.com", name: "Jonas" },
      replyToAddress: null,
      subject: "Hello agent",
      text: "Can you help me with something?",
      attachments: [
        {
          filename: "report.pdf",
          mimeType: "application/pdf",
          size: 1234,
          path: "/email/inbound/msg-0-report.pdf",
        },
      ],
    },
  };
}

const RESOLVED_FILE: AgentFileAttachment = {
  contentType: "application/pdf",
  filename: "report.pdf",
  path: "/email/inbound/msg-0-report.pdf",
  size: 1234,
  url: "https://iterate-files--acme.iterate.app/report.pdf?sig=x",
};

function makeHarness() {
  const resolve: { impl: () => Promise<AgentFileAttachment[]> } = {
    impl: () => {
      throw new Error("must not resolve in this scenario");
    },
  };
  const harness = makeProcessorHarness<EmailAgentProcessorContract>({
    path: HOME,
    createProcessor: (deps) =>
      new EmailAgentProcessor({
        ...deps,
        resolveStoredAttachments: () => resolve.impl(),
      }),
  });
  harness.clock.now = Date.parse("2026-07-15T12:00:00Z");
  void harness.stream.append({
    type: "events.iterate.com/email-agent/created",
    idempotencyKey: "test:email-agent-created",
    payload: { config: { threadId: "1" } },
  });
  return { ...harness, resolve };
}

describe("eviction recovery end to end", () => {
  it("revives a transcription lost to eviction and redelivers the held frame exactly once", async () => {
    const h = makeHarness();
    h.resolve.impl = () => new Promise<never>(() => {});
    await h.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload(),
    });
    expect(h.events("events.iterate.com/agents/context-added")).toHaveLength(0);

    h.crash();
    await h.settle();
    expect(h.events("events.iterate.com/agents/context-added")).toHaveLength(0);

    h.resolve.impl = async () => [RESOLVED_FILE];
    await h.advanceTime(KEEPALIVE_ALARM_LEAD_MS + 1);

    expect(h.events("events.iterate.com/stream/processor-revived")).toMatchObject([
      {
        payload: {
          processorSlug: EmailAgentProcessorContract.slug,
          revivals: 1,
          version: "test-harness",
        },
      },
    ]);
    const inputs = h.events("events.iterate.com/agents/context-added");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).toMatchObject({ files: [RESOLVED_FILE] });
    expect((inputs[0]!.payload as { content: string }).content).toContain(
      "Can you help me with something?",
    );

    await h.settle();
    expect(h.events("events.iterate.com/agents/context-added")).toHaveLength(1);
  });
});
