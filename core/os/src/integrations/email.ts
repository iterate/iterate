// src/integrations/email.ts — A PROJECT'S MAIL, both directions, at `<slug>@<email domain>`
// (email/contract.ts `emailDomainOf`):
//   receiveEmail — the worker's `email()` handler (worker.ts). Cloudflare Email Routing's catch-all
//                  on the email domain delivers every message here; the local part names the
//                  project (a `+tag` after it is ignored). On the project wildcard's domain
//                  (iterate.com on prd) every address routed here is that one project's, and the
//                  message is also forwarded as it arrived to `projectWildcard.forwardEmailTo` (a
//                  Google Group on prd) once the project has it. Each
//                  attachment becomes a project file under `/email/<message key>/`, then
//                  `email/received` lands on `/integrations/email`, keyed by the Message-ID and the
//                  address it reached, so a redelivery lands nothing new and a copy to another of the
//                  project's addresses is its own. The fact says who sent it as far as the platform
//                  can tell (email/sender.ts): whether the From address is verified, whether it is a
//                  member's, whether its domain's own server sent it, and whether the mail is
//                  automated; nothing is refused for it, the reader decides. Mail for no project is
//                  rejected (a bounce the sender sees); a failure of ours throws, and the sending
//                  server retries.
//   sendEmail    — `itx.email.send` (context/built-ins.ts): from the project's own address, or for
//                  the project wildcard's project any address on its domain (`hello@iterate.com`),
//                  with project files attached, then `email/sent` on `/integrations/email`. Given
//                  `inReplyToOffset`, a message on that log, it answers it in its thread, from the
//                  address it arrived at when the project may send from that one. A send code
//                  makes while it handles a delivery is reserved first, so a retry answers the
//                  mail it sent and never sends it twice (cause.ts).
// Both record their fact through `recordEmail`, as the platform: the `email` facet folds only
// those (email/processor.ts).
import PostalMime, { type Address } from "postal-mime";
import { codedError, ITERATE_CAUSE_HEADER } from "iterate/lib";
import type { EmailSendInput, StreamPage } from "iterate/api";
import { EmailContract } from "iterate/email";
import type { StreamEvent, StreamEventInput } from "iterate/stream/processor";
import { z } from "zod";
import {
  causeHeader,
  LOOP_DEPTH_LIMIT,
  newChain,
  parseCause,
  refuseActPastLimit,
  storedCause,
} from "../cause.ts";
import { appConfigOf } from "../app-config.ts";
import { sha256Hex, type Caller } from "../caller.ts";
import { DurableObjectNameCodec, resourceScope } from "../context/paths.ts";
import { ControlPlane } from "../control-plane/edge.ts";
import type { Env } from "../env.ts";
import type { ReachableContext } from "../stream/stream.ts";
import { EMAIL_PATH, emailDomainOf } from "../email/contract.ts";
import { authenticationOf, isAutomated } from "../email/sender.ts";

/** A body longer than this many characters is cut, so no message outgrows one event. */
const BODY_MAX_CHARS = 100_000;

export async function receiveEmail(message: ForwardableEmailMessage, env: Env) {
  const { urls } = appConfigOf(env);
  const recipient = /^([^@+]+)(?:\+[^@]*)?@(.+)$/.exec(message.to.trim().toLowerCase());
  const wildcard = urls.projectWildcard;
  const viaWildcard = !!recipient && !!wildcard && recipient[2] === wildcard.hostname;
  let projectRef: string | undefined;
  if (recipient && recipient[2] === emailDomainOf(urls.ingressRouting)) projectRef = recipient[1];
  else if (viaWildcard) projectRef = wildcard.project;
  const controlPlane = new ControlPlane(env);
  const project = projectRef ? await controlPlane.getProject(projectRef) : null;
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
  const { authentication, verified, direct } = authenticationOf(email.headers, from);
  const user = verified ? await controlPlane.getUser(from) : null;
  const member = !!user && (await controlPlane.reachesProject({ userId: user.id }, project.id));
  // Mail we sent resumes the chain it carries (sendEmail's mark); any other begins one. Mail is
  // always recorded, so one past the loop limit lands at it: what reacts to it can only read.
  const mark = parseCause(
    email.headers.find(({ key }) => key === ITERATE_CAUSE_HEADER.toLowerCase())?.value,
  );
  await recordEmail(
    env.ITERATE_CONTEXT.getByName(
      DurableObjectNameCodec.stringify({ projectId: project.id, path: EMAIL_PATH }),
    ),
    {
      principal: null,
      cause: mark
        ? { ...storedCause(mark), depth: Math.min(mark.depth, LOOP_DEPTH_LIMIT) }
        : newChain("inbound mail"),
    },
    {
      type: "events.iterate.com/email/received",
      idempotencyKey: `email/received:${messageKey}:${message.to.toLowerCase()}`,
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
        sender: { verified, member, direct },
        automated: isAutomated(email.headers, message.from),
        authentication,
      },
    },
  );
  if (viaWildcard && wildcard.forwardEmailTo) {
    try {
      await message.forward(wildcard.forwardEmailTo);
    } catch (error) {
      // Email Routing forwards only mail that passes SPF or DKIM; the project has this one anyway.
      // Any other failure throws, the sender retries, and the redelivery is recorded once.
      if (!String(error).includes("non-authenticated emails cannot be forwarded")) throw error;
    }
  }
}

/** What `itx.email.send` takes, checked here: it arrives over the wire. */
const SendInput = z.object({
  from: z.string().optional(),
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
    /** The project's own address, its display name, and the domain whose every address it may
     *  send from too (the project wildcard's, for its project), or null. */
    address: string;
    name: string;
    ownDomain: string | null;
    emailContext: Pick<ReachableContext, "invoke" | "reserveSend" | "releaseSend">;
    caller: Caller;
  },
  input: EmailSendInput,
) {
  // A send is an act: past the loop limit, nothing is mailed (cause.ts).
  refuseActPastLimit(scope.caller.cause, "itx.email.send");
  const parsed = SendInput.safeParse(input);
  if (!parsed.success) throw codedError("INVALID_INPUT", `itx.email.send: ${parsed.error.message}`);
  const request = parsed.data;
  const answered = request.inReplyToOffset
    ? await answeredMessageOf(scope.emailContext, request.inReplyToOffset, scope.caller)
    : null;
  const to = request.to ? [request.to].flat() : answered?.to || [];
  const cc = request.cc ? [request.cc].flat() : answered?.cc || [];
  const subject = request.subject || answered?.subject || "";
  const mayUse = (address: string) =>
    address === scope.address ||
    (!!scope.ownDomain &&
      /^[^@\s<>]+@[^@\s<>]+$/.test(address) &&
      address.endsWith(`@${scope.ownDomain}`));
  const answeredAt = answered?.receivedAt.toLowerCase();
  const from =
    request.from?.trim().toLowerCase() ||
    (answeredAt && mayUse(answeredAt) ? answeredAt : scope.address);
  if (!mayUse(from))
    throw codedError(
      "FORBIDDEN",
      `itx.email.send: this project sends from ${scope.address}${scope.ownDomain ? ` or any address @${scope.ownDomain}` : ""}, not ${from}`,
    );
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
  // AT MOST ONCE A DELIVERY (cause.ts, stable retry effects): a send code makes while it handles a
  // delivery is keyed by the delivery and the message, the same on every attempt, and reserved in
  // `/integrations/email`'s storage before it goes. A retry answers the `email/sent` recorded under
  // the key; a send the binding refused frees it for the retry; one that may have gone out with
  // nothing recorded is not sent again: the delivery fails for good, and says so.
  const writeKey = scope.caller.cause?.writeKey;
  const key =
    writeKey &&
    `${writeKey}:email.send:${(await sha256Hex(JSON.stringify([to, cc, subject, request.text, request.html]))).slice(0, 16)}`;
  if (key) {
    const { recorded, reserved } = await scope.emailContext.reserveSend(key);
    if (recorded) return recorded;
    if (!reserved)
      throw codedError(
        "PERMANENT_FAILURE",
        "itx.email.send: an earlier attempt of this delivery sent this message or may have, and recorded nothing — it is not sent again",
      );
  }
  const references = answered?.references || [];
  const sent = await scope.EMAIL.send({
    from: { email: from, name: scope.name },
    to,
    ...(cc.length > 0 && { cc }),
    subject,
    text: request.text,
    html: request.html,
    headers: {
      // OUR MARK (cause.ts): mail that comes back resumes the chain.
      "Auto-Submitted": "auto-generated",
      ...(scope.caller.cause && {
        [ITERATE_CAUSE_HEADER]: causeHeader(scope.caller.cause),
      }),
      ...(answered?.inReplyTo && {
        "In-Reply-To": `<${answered.inReplyTo}>`,
        References: referencesHeaderOf(references),
      }),
    },
    ...(attachments.length > 0 && {
      attachments: attachments.map(({ filename, contentType, content }) => ({
        disposition: "attachment" as const,
        filename,
        type: contentType,
        content,
      })),
    }),
  }).catch(async (error: unknown) => {
    if (key) await scope.emailContext.releaseSend(key); // refused: nothing went out
    throw error;
  });
  return recordEmail(scope.emailContext, scope.caller, {
    type: "events.iterate.com/email/sent",
    idempotencyKey: key || undefined,
    payload: {
      messageId: bareMessageIdsOf(sent.messageId)[0] ?? null,
      from,
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
) {
  const asPlatform: Caller = { ...caller, platform: true };
  await emailContext.invoke(["itx", "builtins", "processors", ["enable", "email"]], [], asPlatform);
  // `invoke` is untyped across the DO hop; the `append` built-in answers the committed events.
  const [recorded] = (await emailContext.invoke(
    ["itx", "builtins", ["append", event]],
    [],
    asPlatform,
  )) as StreamEvent[];
  return recorded!;
}

/** What a reply to the message at `offset` on `/integrations/email` takes from it: its recipients
 *  (the author, or where they asked for replies; for our own message, the same people again), the
 *  address it reached us at (for our own message, the one we sent it from), its subject, and the
 *  threading ids. */
async function answeredMessageOf(
  emailContext: Pick<ReachableContext, "invoke">,
  offset: number,
  caller: Caller,
) {
  // read under the sender's caller, so a read that wakes /integrations/email is caused by its chain
  const page = (await emailContext.invoke(
    ["itx", "builtins", ["readEvents", offset - 1, 1]],
    [],
    caller,
  )) as StreamPage;
  const [event] = page.events;
  const found = event?.offset === offset ? event : undefined;
  const { events } = EmailContract;
  const received =
    found?.type === "events.iterate.com/email/received"
      ? events["events.iterate.com/email/received"].payloadSchema.safeParse(found.payload).data
      : undefined;
  const message =
    received ||
    (found?.type === "events.iterate.com/email/sent"
      ? events["events.iterate.com/email/sent"].payloadSchema.safeParse(found.payload).data
      : undefined);
  if (!message)
    throw codedError(
      "INVALID_INPUT",
      `itx.email.send: ${EMAIL_PATH} has no message at offset ${offset}`,
    );
  return {
    to: received ? [received.replyTo || received.from] : message.to,
    cc: received ? [] : message.cc,
    receivedAt: received ? received.envelope.to : message.from,
    subject: /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`,
    inReplyTo: message.messageId,
    references: [...message.references, ...(message.messageId ? [message.messageId] : [])],
  };
}

/** A References header under Email Service's 2,048-byte limit: the thread's first id and as many
 *  of its latest as fit (RFC 5322 3.6.4 keeps the first). */
function referencesHeaderOf(references: string[]) {
  const bracketed = references.map((id) => `<${id}>`);
  while (bracketed.length > 2 && bracketed.join(" ").length > 2000) bracketed.splice(1, 1);
  return bracketed.join(" ");
}

/** Every message id in a Message-ID, In-Reply-To or References value, angle brackets off; a value
 *  with none bracketed is one bare id. */
function bareMessageIdsOf(value: string | undefined) {
  const bracketed = [...(value || "").matchAll(/<([^<>\s]+)>/g)].map((match) => match[1]!);
  return bracketed.length > 0 || !value?.trim() ? bracketed : [value.trim()];
}

/** The addresses of parsed recipients, a group's members among them. */
function addressesOf(list: Address[] | undefined) {
  return (list || []).flatMap((entry) =>
    (entry.group || [entry]).map((mailbox) => mailbox.address),
  );
}

function cutBody(body: string) {
  return body.length > BODY_MAX_CHARS ? `${body.slice(0, BODY_MAX_CHARS)}\n[truncated]` : body;
}
