// src/integrations/email.ts — A PROJECT'S MAIL, both directions, at `<slug>@<email domain>`
// (email/contract.ts `emailDomainOf`):
//   receiveEmail — the worker's `email()` handler (worker.ts). Cloudflare Email Routing's catch-all
//                  on the email domain delivers every message here; the local part names the
//                  project (a `+tag` after it is ignored). Each attachment becomes a project file
//                  under `/email/<message key>/`, then `email/received` lands on `/integrations/email`,
//                  keyed by the Message-ID, so a redelivery lands nothing new. Mail for no project
//                  is rejected (a bounce the sender sees); a failure of ours throws, and the sending
//                  server retries.
//   sendEmail    — `itx.email.send` (context/built-ins.ts): from the project's own address, with
//                  project files attached, then `email/sent` on `/integrations/email`. Given
//                  `inReplyToOffset`, a message on that log, it answers it in its thread.
// Both record their fact through `recordEmail`, as the platform: the `email` facet folds only
// those (email/processor.ts).
import PostalMime, { type Address } from "postal-mime";
import { codedError } from "iterate/lib";
import type { EmailSendInput } from "iterate/api";
import type { StreamEvent, StreamEventInput } from "iterate/stream/processor";
import { z } from "zod";
import { appConfigOf } from "../app-config.ts";
import type { Caller } from "../caller.ts";
import { DurableObjectNameCodec, resourceScope } from "../context/paths.ts";
import { ControlPlane } from "../control-plane/edge.ts";
import type { Env } from "../env.ts";
import { sha256Hex } from "../secrets.ts";
import type { ReachableContext } from "../stream/stream.ts";
import { EMAIL_PATH, EmailContract, emailDomainOf } from "../email/contract.ts";

/** A body longer than this many characters is cut, so no message outgrows one event. */
const BODY_MAX_CHARS = 100_000;

export async function receiveEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const domain = emailDomainOf(appConfigOf(env).urls.ingressRouting);
  const recipient = /^([^@+]+)(?:\+[^@]*)?@(.+)$/.exec(message.to.trim().toLowerCase());
  const project =
    recipient && recipient[2] === domain
      ? await new ControlPlane(env).getProject(recipient[1]!)
      : null;
  if (!project) return message.setReject("No such address.");

  const raw = await new Response(message.raw).arrayBuffer();
  const email = await PostalMime.parse(raw);
  const messageId = bareMessageIdsOf(email.messageId)[0] ?? null;
  // Names the message's files and its fact: the Message-ID, else the message itself.
  const messageKey = (await sha256Hex(messageId || new TextDecoder().decode(raw))).slice(0, 16);
  const attachments = await Promise.all(
    email.attachments.map(async (attachment, index) => {
      const filename = attachment.filename || `attachment-${index + 1}`;
      const path = `/email/${messageKey}/${index + 1}-${filename.replace(/[^\w.-]+/g, "_")}`;
      const contentType = attachment.mimeType || "application/octet-stream";
      // the project's file at `path` (library.ts `fileHandle`: its key is the path, owner-prefixed)
      const stored = await env.FILES.put(
        `${resourceScope(project.id, "/").id}${path}`,
        attachment.content,
        { httpMetadata: { contentType } },
      );
      return { filename, contentType, size: stored.size, path };
    }),
  );
  const replyTo = addressesOf(email.replyTo)[0];
  const from = addressesOf(email.from && [email.from])[0] ?? message.from;
  await recordEmail(
    env.ITERATE_CONTEXT.getByName(
      DurableObjectNameCodec.stringify({ projectId: project.id, path: EMAIL_PATH }),
    ),
    { principal: null },
    {
      type: "events.iterate.com/email/received",
      idempotencyKey: `email/received:${messageKey}`,
      payload: {
        messageId,
        from,
        ...(replyTo && replyTo !== from && { replyTo }),
        to: addressesOf(email.to),
        cc: addressesOf(email.cc),
        subject: email.subject || "",
        text: email.text ? cutBody(email.text) : null,
        html: email.html ? cutBody(email.html) : null,
        inReplyTo: bareMessageIdsOf(email.inReplyTo)[0] ?? null,
        references: bareMessageIdsOf(email.references),
        attachments,
        envelope: { from: message.from, to: message.to },
      },
    },
  );
}

/** What `itx.email.send` takes, checked here: it arrives over the wire. */
const SendInput = z.object({
  to: z.union([z.string(), z.array(z.string())]).optional(),
  cc: z.union([z.string(), z.array(z.string())]).optional(),
  subject: z.string().optional(),
  text: z.string().optional(),
  html: z.string().optional(),
  inReplyToOffset: z.number().int().positive().optional(),
  attachments: z.array(z.object({ path: z.string(), filename: z.string().optional() })).optional(),
});

export async function sendEmail(
  scope: {
    EMAIL: SendEmail;
    /** The project's own slice of the files bucket, its key prefix (`<projectId>/`). */
    FILES: R2Bucket;
    filesPrefix: string;
    /** The project's address and its display name. */
    from: { email: string; name: string };
    emailContext: Pick<ReachableContext, "invoke" | "read">;
    caller: Caller;
  },
  input: EmailSendInput,
): Promise<StreamEvent> {
  const parsed = SendInput.safeParse(input);
  if (!parsed.success) throw codedError("INVALID_INPUT", `itx.email.send: ${parsed.error.message}`);
  const request = parsed.data;
  const answered =
    request.inReplyToOffset === undefined
      ? null
      : await answeredMessageOf(scope.emailContext, request.inReplyToOffset);
  const to = request.to ? [request.to].flat() : answered?.to || [];
  const cc = request.cc ? [request.cc].flat() : answered?.cc || [];
  const subject = request.subject || answered?.subject || "";
  if (to.length + cc.length === 0 || !(request.text || request.html))
    throw codedError(
      "INVALID_INPUT",
      "itx.email.send: name a recipient (`to`, `cc`, or `inReplyToOffset`) and a `text` or `html` body",
    );
  const attachments = await Promise.all(
    (request.attachments || []).map(async ({ path, filename }) => {
      const object = await scope.FILES.get(`${scope.filesPrefix}${path.replace(/^\/+/, "")}`);
      if (!object) throw codedError("INVALID_INPUT", `itx.email.send: no file at ${path}`);
      return {
        filename: filename || path.split("/").pop()!,
        contentType: object.httpMetadata?.contentType || "application/octet-stream",
        size: object.size,
        path,
        content: await object.arrayBuffer(),
      };
    }),
  );
  const references = answered?.references || [];
  const sent = await scope.EMAIL.send({
    from: scope.from,
    to,
    ...(cc.length > 0 && { cc }),
    subject,
    text: request.text,
    html: request.html,
    ...(answered?.inReplyTo && {
      headers: {
        "In-Reply-To": `<${answered.inReplyTo}>`,
        References: referencesHeaderOf(references),
      },
    }),
    ...(attachments.length > 0 && {
      attachments: attachments.map(({ filename, contentType, content }) => ({
        disposition: "attachment" as const,
        filename,
        type: contentType,
        content,
      })),
    }),
  });
  return recordEmail(scope.emailContext, scope.caller, {
    type: "events.iterate.com/email/sent",
    payload: {
      messageId: bareMessageIdsOf(sent.messageId)[0] ?? null,
      from: scope.from.email,
      to,
      cc,
      subject,
      text: request.text || null,
      html: request.html || null,
      inReplyTo: answered?.inReplyTo || null,
      references,
      attachments: attachments.map(({ content: _bytes, ...attachment }) => attachment),
    },
  });
}

/** One message's fact on `/integrations/email`, as the platform: the `email` facet's row enabled
 *  there first (a no-op once it is), so the facet folds it. */
async function recordEmail(
  emailContext: Pick<ReachableContext, "invoke">,
  caller: Caller,
  event: StreamEventInput,
): Promise<StreamEvent> {
  const asPlatform: Caller = { ...caller, platform: true };
  await emailContext.invoke(["itx", "builtins", "processors", ["enable", "email"]], [], asPlatform);
  const [recorded] = (await emailContext.invoke(
    ["itx", "builtins", ["append", event]],
    [],
    asPlatform,
  )) as StreamEvent[];
  return recorded!;
}

/** What a reply to the message at `offset` on `/integrations/email` takes from it: its recipients
 *  (the author, or where they asked for replies; for our own message, the same people again), its
 *  subject, and the threading ids. */
async function answeredMessageOf(emailContext: Pick<ReachableContext, "read">, offset: number) {
  const [event] = (await emailContext.read(offset - 1, 1)).events;
  const { events } = EmailContract;
  const at = (type: string) => event?.offset === offset && event.type === type;
  const received = at("events.iterate.com/email/received")
    ? events["events.iterate.com/email/received"].payloadSchema.safeParse(event!.payload).data
    : undefined;
  const message =
    received ||
    (at("events.iterate.com/email/sent")
      ? events["events.iterate.com/email/sent"].payloadSchema.safeParse(event!.payload).data
      : undefined);
  if (!message)
    throw codedError(
      "INVALID_INPUT",
      `itx.email.send: ${EMAIL_PATH} has no message at offset ${offset}`,
    );
  return {
    to: received ? [received.replyTo || received.from] : message.to,
    cc: received ? [] : message.cc,
    subject: /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`,
    inReplyTo: message.messageId,
    references: [...message.references, ...(message.messageId ? [message.messageId] : [])],
  };
}

/** A References header under Email Service's 2,048-byte limit: the thread's first id and as many
 *  of its latest as fit (RFC 5322 3.6.4 keeps the first). */
function referencesHeaderOf(references: string[]): string {
  const bracketed = references.map((id) => `<${id}>`);
  while (bracketed.length > 2 && bracketed.join(" ").length > 2000) bracketed.splice(1, 1);
  return bracketed.join(" ");
}

/** Every message id in a Message-ID, In-Reply-To or References value, angle brackets off; a value
 *  with none bracketed is one bare id. */
function bareMessageIdsOf(value: string | undefined): string[] {
  const bracketed = [...(value || "").matchAll(/<([^<>\s]+)>/g)].map((match) => match[1]!);
  return bracketed.length > 0 || !value?.trim() ? bracketed : [value.trim()];
}

/** The addresses of parsed recipients, a group's members among them. */
function addressesOf(list: Address[] | undefined): string[] {
  return (list || []).flatMap((entry) =>
    (entry.group || [entry]).map((mailbox) => mailbox.address),
  );
}

function cutBody(body: string): string {
  return body.length > BODY_MAX_CHARS ? `${body.slice(0, BODY_MAX_CHARS)}\n[truncated]` : body;
}
