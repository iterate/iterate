// __workers-tests__/email.test.ts — a project's mail on the worker: the `email()` door
// (src/integrations/email.ts `receiveEmail`) records a message and its attachment on
// `/integrations/email` once however often it is delivered, bounces mail for no project, and
// `itx.email.send` answers a message in its thread, which the `email` facet folds. Projects' mail
// is at `<slug>@projects.test` here (wrangler.test.jsonc's ingress hostname).
import { env } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import type { StreamEvent } from "iterate/stream/processor";
import { DurableObjectNameCodec } from "../src/context/paths.ts";
import type { EmailState } from "../src/email/contract.ts";
import { receiveEmail } from "../src/integrations/email.ts";
import type { Env } from "../src/env.ts";
import { projectWithMember, readLog, snapshot } from "./support.ts";

test("a message to a project lands once on /integrations/email with its attachment a project file, and a reply threads with it", async () => {
  const member = await projectWithMember("mailbox");
  const inbox = DurableObjectNameCodec.stringify({
    projectId: member.projectId,
    path: "/integrations/email",
  });
  const invoice = [
    "From: Ann <ann@example.com>",
    "To: mailbox@projects.test",
    "Subject: Invoice",
    "Message-ID: <a1@example.com>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b"',
    "",
    "--b",
    "Content-Type: text/plain",
    "",
    "Please see attached.",
    "--b",
    'Content-Type: text/plain; name="note.txt"',
    'Content-Disposition: attachment; filename="note.txt"',
    "Content-Transfer-Encoding: base64",
    "",
    "aGVsbG8=",
    "--b--",
  ].join("\r\n");
  for (const _delivery of [1, 2])
    expect(await deliver("mailbox@projects.test", invoice)).toMatchObject({ rejected: [] });

  const [received, ...again] = mailOf(await readLog(inbox));
  expect(again).toEqual([]);
  expect(received).toMatchObject({
    type: "events.iterate.com/email/received",
    payload: {
      messageId: "a1@example.com",
      from: "ann@example.com",
      to: ["mailbox@projects.test"],
      subject: "Invoice",
      text: "Please see attached.\n",
      inReplyTo: null,
      references: [],
      attachments: [{ filename: "note.txt", contentType: "text/plain", size: 5 }],
      envelope: { from: "ann@example.com", to: "mailbox@projects.test" },
    },
  });
  const [attachment] = (received!.payload as { attachments: { path: string }[] }).attachments;
  expect(new TextDecoder().decode(await member.itx.files.get(attachment!.path).bytes())).toBe(
    "hello",
  );

  const reply = (await member.itx.email.send({
    inReplyToOffset: received!.offset,
    text: "Thanks!",
  })) as StreamEvent;
  expect(reply).toMatchObject({
    type: "events.iterate.com/email/sent",
    payload: {
      from: "mailbox@projects.test",
      to: ["ann@example.com"],
      subject: "Re: Invoice",
      text: "Thanks!",
      inReplyTo: "a1@example.com",
      references: ["a1@example.com"],
    },
  });
  // Their answer to the reply names the whole chain; the thread is the first message's.
  await deliver(
    "mailbox+anything@projects.test",
    [
      "From: ann@example.com",
      "To: mailbox@projects.test",
      "Subject: Re: Invoice",
      "Message-ID: <a2@example.com>",
      "In-Reply-To: <unseen@projects.test>",
      "References: <a1@example.com> <unseen@projects.test>",
      "",
      "You're welcome.",
    ].join("\r\n"),
  );
  const answer = mailOf(await readLog(inbox)).at(-1)!;
  await vi.waitFor(async () =>
    expect((await snapshot<EmailState>(inbox, "email")).state).toMatchObject({
      threads: {
        [received!.offset]: {
          subject: "Invoice",
          messageOffsets: [received!.offset, reply.offset, answer.offset],
        },
      },
    }),
  );
});

test("mail for no project, or on another domain, bounces", async () => {
  await projectWithMember("bounces");
  const note = "From: ann@example.com\r\nSubject: Hi\r\n\r\nHello";
  expect(await deliver("nobody-here@projects.test", note)).toMatchObject({
    rejected: ["No such address."],
  });
  expect(await deliver("bounces@elsewhere.test", note)).toMatchObject({
    rejected: ["No such address."],
  });
});

/** One delivery by Cloudflare Email Routing to `to`, and what the door rejected it with. */
async function deliver(to: string, mime: string) {
  const rejected: string[] = [];
  const raw = new TextEncoder().encode(mime);
  // the fields of a ForwardableEmailMessage the door reads
  const message = {
    from: "ann@example.com",
    to,
    raw: new Response(raw).body!,
    rawSize: raw.byteLength,
    headers: new Headers(),
    setReject: (reason: string) => void rejected.push(reason),
  } as unknown as ForwardableEmailMessage;
  await receiveEmail(message, env as unknown as Env);
  return { rejected };
}

function mailOf(events: StreamEvent[]) {
  return events.filter((event) => event.type.startsWith("events.iterate.com/email/"));
}
