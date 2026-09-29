// __workers-tests__/email.test.ts — a project's mail on the worker (src/integrations/email.ts), at
// `<slug>@projects.test` here (wrangler.test.jsonc's ingress hostname).
import { expect, test, vi } from "vitest";
import type { StreamEvent } from "iterate/stream/processor";
import type { EmailState } from "iterate/email";
import { DurableObjectNameCodec } from "../src/context/paths.ts";
import { deliverMail, projectWithMember, readLog, snapshot, stub } from "./support.ts";

test("a message lands once per project address on /integrations/email with its attachment a project file, and a reply threads with it", async () => {
  const member = await projectWithMember("mailbox");
  const inbox = DurableObjectNameCodec.stringify({
    projectId: member.projectId,
    path: "/integrations/email",
  });
  const invoice = [
    "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=example.com; dmarc=pass header.from=example.com; spf=pass smtp.mailfrom=ann@example.com",
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
  // delivered twice to one address, and once to another of the project's
  for (const to of ["mailbox@projects.test", "mailbox@projects.test", "mailbox+cc@projects.test"])
    expect(await deliverMail(to, invoice)).toMatchObject({ rejected: [], forwarded: [] });

  const [received, copy, ...again] = mailOf(await readLog(inbox));
  expect(again).toEqual([]);
  expect(copy).toMatchObject({ payload: { envelope: { to: "mailbox+cc@projects.test" } } });
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
      sender: { verified: true, member: false, direct: true },
      automated: false,
      authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
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
    source: { origin: "/" },
  });
  // a child's send names the child, which runs it itself through its link to the root
  const child = stub(`${member.projectId}.iterate/agents/a`);
  await child.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx", target: "itx.cd('/')" },
  });
  expect(
    await child.invoke([
      "itx",
      "email",
      ["send", { to: "ann@example.com", subject: "From a child", text: "…" }],
    ]),
  ).toMatchObject({ source: { origin: "/agents/a" } });
  // Their answer to the reply names the whole chain; the thread is the first message's.
  await deliverMail(
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
          messageOffsets: [received!.offset, copy!.offset, reply.offset, answer.offset],
        },
      },
    }),
  );
});

test("a member's verified message says so, and a forged one claiming to be theirs is unverified", async () => {
  const member = await projectWithMember("members-mail");
  const inbox = DurableObjectNameCodec.stringify({
    projectId: member.projectId,
    path: "/integrations/email",
  });
  const fromTheMember = (results: string[], messageId: string) =>
    [
      ...results.map((record) => `Authentication-Results: ${record}`),
      "From: members-mail@example.test",
      "To: members-mail@projects.test",
      "Subject: Hi",
      `Message-ID: <${messageId}@example.test>`,
      "",
      "Hello",
    ].join("\r\n");
  await deliverMail(
    "members-mail@projects.test",
    fromTheMember(["mx.cloudflare.net; dkim=pass header.d=example.test; dmarc=none"], "real"),
  );
  // Cloudflare's real verdict on top, the sender's forged pass below it
  await deliverMail(
    "members-mail@projects.test",
    fromTheMember(
      [
        "mx.cloudflare.net; dkim=none; dmarc=none; spf=softfail smtp.mailfrom=members-mail@example.test",
        "mx.cloudflare.net; dkim=pass header.d=example.test; dmarc=pass header.from=example.test",
      ],
      "forged",
    ),
  );
  expect(mailOf(await readLog(inbox)).map((event) => event.payload)).toMatchObject([
    {
      messageId: "real@example.test",
      // a DKIM signature alone: verified, but not direct (anyone could re-send it)
      sender: { verified: true, member: true, direct: false },
    },
    {
      messageId: "forged@example.test",
      sender: { verified: false, member: false, direct: false },
      authentication: { spf: "softfail", dkim: "none", dmarc: "none" },
    },
  ]);
});

test("the project wildcard's project receives mail at any address on its domain, answers from the address it reached, and sends from any other there", async () => {
  const member = await projectWithMember("wildcard-mail");
  const hello =
    "From: ann@example.com\r\nSubject: Hi\r\nMessage-ID: <hello@example.com>\r\n\r\nHello";
  // recorded for the project, and forwarded as it arrived to the wildcard's forwardEmailTo
  expect(await deliverMail("hello@wildcard.test", hello)).toMatchObject({
    rejected: [],
    forwarded: ["everything@example.test"],
  });
  const inbox = DurableObjectNameCodec.stringify({
    projectId: member.projectId,
    path: "/integrations/email",
  });
  // mail Email Routing will not forward (no SPF or DKIM pass) is recorded all the same
  const unforwardable =
    "From: ann@example.com\r\nSubject: Psst\r\nMessage-ID: <psst@example.com>\r\n\r\nPsst";
  expect(
    await deliverMail("someone@wildcard.test", unforwardable, {
      forward: () => {
        throw new Error("non-authenticated emails cannot be forwarded");
      },
    }),
  ).toMatchObject({ rejected: [] });
  const [received, unforwarded] = mailOf(await readLog(inbox));
  expect(received).toMatchObject({
    type: "events.iterate.com/email/received",
    payload: { messageId: "hello@example.com", envelope: { to: "hello@wildcard.test" } },
  });
  expect(unforwarded).toMatchObject({
    payload: { messageId: "psst@example.com", envelope: { to: "someone@wildcard.test" } },
  });

  const reply = (await member.itx.email.send({
    inReplyToOffset: received!.offset,
    text: "Hello back",
  })) as StreamEvent;
  expect(reply).toMatchObject({
    payload: { from: "hello@wildcard.test", to: ["ann@example.com"], subject: "Re: Hi" },
  });
  const news = (await member.itx.email.send({
    from: "News@Wildcard.test",
    to: "ann@example.com",
    subject: "News",
    text: "…",
  })) as StreamEvent;
  expect(news).toMatchObject({ payload: { from: "news@wildcard.test" } });
  const plain = (await member.itx.email.send({
    to: "ann@example.com",
    subject: "Plain",
    text: "…",
  })) as StreamEvent;
  expect(plain).toMatchObject({ payload: { from: "wildcard-mail@projects.test" } });
});

test("no other project sends from the wildcard's domain or from another project's address", async () => {
  const other = await projectWithMember("not-the-wildcard");
  for (const from of ["hello@wildcard.test", "wildcard-mail@projects.test"])
    await expect(
      other.itx.email.send({ from, to: "ann@example.com", subject: "Hi", text: "…" }),
    ).rejects.toThrow(`this project sends from not-the-wildcard@projects.test, not ${from}`);
});

test("mail for no project, or on another domain, bounces", async () => {
  await projectWithMember("bounces");
  const note = "From: ann@example.com\r\nSubject: Hi\r\n\r\nHello";
  expect(await deliverMail("nobody-here@projects.test", note)).toMatchObject({
    rejected: ["No such address."],
  });
  expect(await deliverMail("bounces@elsewhere.test", note)).toMatchObject({
    rejected: ["No such address."],
  });
});

function mailOf(events: StreamEvent[]) {
  return events.filter((event) => event.type.startsWith("events.iterate.com/email/"));
}
