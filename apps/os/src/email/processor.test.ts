// src/email/processor.test.ts — the EmailProcessor's executable spec: `{ events → threads }` rows on
// the shared processor harness (iterate/stream/test-support `reduceProcessor`). Offsets start at 1.
import { expect, test } from "vitest";
import { reduceProcessor } from "iterate/stream/test-support";
import { EmailProcessor } from "./processor.ts";

test.for([
  {
    row: "a message nobody answered is a thread of its own",
    events: [received({ messageId: "a@x", subject: "Hi" })],
    threads: { 1: { subject: "Hi", messageOffsets: [1] } },
  },
  {
    row: "our reply and their answer to it join the thread",
    events: [
      received({ messageId: "a@x", subject: "Hi" }),
      sent({ messageId: "b@iterate.app", inReplyTo: "a@x", references: ["a@x"] }),
      received({
        messageId: "c@x",
        inReplyTo: "b@iterate.app",
        references: ["a@x", "b@iterate.app"],
      }),
    ],
    threads: { 1: { subject: "Hi", messageOffsets: [1, 2, 3] } },
  },
  {
    row: "a reply whose parent we never saw joins the thread of its nearest known ancestor",
    events: [
      received({ messageId: "a@x", subject: "Hi" }),
      received({ messageId: "c@x", inReplyTo: "b@elsewhere", references: ["a@x", "b@elsewhere"] }),
    ],
    threads: { 1: { subject: "Hi", messageOffsets: [1, 2] } },
  },
  {
    row: "a message we sent unprompted starts a thread their reply joins",
    events: [
      received({ messageId: "a@x", subject: "Hi" }),
      sent({ messageId: "b@iterate.app", subject: "News" }),
      received({ messageId: "c@x", inReplyTo: "b@iterate.app", references: ["b@iterate.app"] }),
    ],
    threads: {
      1: { subject: "Hi", messageOffsets: [1] },
      2: { subject: "News", messageOffsets: [2, 3] },
    },
  },
  {
    row: "a second copy of a message, to another of our addresses, joins its thread",
    events: [
      received({ messageId: "a@x", subject: "Hi" }),
      received({ messageId: "a@x", subject: "Hi" }),
      received({ messageId: "c@x", inReplyTo: "a@x", references: ["a@x"] }),
    ],
    threads: { 1: { subject: "Hi", messageOffsets: [1, 2, 3] } },
  },
])("the email threads — $row", ({ events, threads }) =>
  expect(reduceProcessor(new EmailProcessor(), events)).toEqual({
    threads,
    threadOffsetByMessageId: expect.any(Object),
  }),
);

test("the email threads — a message with no Message-ID is a thread of its own, and one with none that answers joins", () =>
  expect(
    reduceProcessor(new EmailProcessor(), [
      received({ messageId: "a@x", subject: "Hi" }),
      received({ subject: "Other" }),
      received({ subject: "Another" }),
      received({ inReplyTo: "a@x", references: ["a@x"] }),
    ]),
  ).toEqual({
    threads: {
      1: { subject: "Hi", messageOffsets: [1, 4] },
      2: { subject: "Other", messageOffsets: [2] },
      3: { subject: "Another", messageOffsets: [3] },
    },
    threadOffsetByMessageId: { "a@x": 1 },
  }));

function received(message: MessageInput) {
  return {
    type: "events.iterate.com/email/received",
    payload: {
      ...messageOf(message),
      envelope: { from: "ann@x", to: "acme@iterate.app" },
      sender: { verified: true, member: false, direct: true },
      automated: false,
      authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
    },
    source: { platform: true as const },
  };
}

function sent(message: MessageInput) {
  return {
    type: "events.iterate.com/email/sent",
    payload: messageOf(message),
    source: { platform: true as const },
  };
}

type MessageInput = Partial<{
  messageId: string;
  subject: string;
  inReplyTo: string;
  references: string[];
}>;

function messageOf(message: MessageInput) {
  return {
    messageId: message.messageId || null,
    from: "ann@x",
    to: ["acme@iterate.app"],
    cc: [],
    subject: message.subject || "Re: Hi",
    text: "…",
    html: null,
    inReplyTo: message.inReplyTo || null,
    references: message.references || [],
    attachments: [],
  };
}
