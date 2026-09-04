import { z } from "zod";

const ATTACHMENT_DESTINATION_PREFIX = "attachment:";
const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~%:/-]*$/;
const ATTACHMENT_LINK_PATTERN =
  /\[((?:\\.|[^\\\]])*)\]\(attachment:([A-Za-z0-9][A-Za-z0-9._~%:/-]*)\)/g;
const MAX_MESSAGE_ATTACHMENTS = 100;

export const AgentConfigRepoFileAttachmentTarget = z.strictObject({
  type: z.literal("repo-file"),
  repoPath: z.literal("/repos/config"),
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine(isCanonicalRepoFilePath, "must be a canonical repository file path"),
});
export type AgentConfigRepoFileAttachmentTarget = z.infer<
  typeof AgentConfigRepoFileAttachmentTarget
>;

/** A resource which can be linked from an agent message. Add future kinds here. */
export const AgentMessageAttachmentTarget = z.discriminatedUnion("type", [
  AgentConfigRepoFileAttachmentTarget,
]);
export type AgentMessageAttachmentTarget = z.infer<typeof AgentMessageAttachmentTarget>;

export const AgentMessageAttachment = z
  .strictObject({
    id: z.string().max(8192).regex(ATTACHMENT_ID_PATTERN, "must be safe in an attachment link"),
    ...AgentConfigRepoFileAttachmentTarget.shape,
  })
  .superRefine((attachment, context) => {
    let expectedId: string;
    try {
      expectedId = agentMessageAttachmentId(attachment);
    } catch {
      context.addIssue({
        code: "custom",
        path: ["path"],
        message: "must contain valid Unicode",
      });
      return;
    }
    if (attachment.id !== expectedId) {
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: "must identify the attached resource",
      });
    }
  });
export type AgentMessageAttachment = z.infer<typeof AgentMessageAttachment>;

export const AgentMessageAttachments = z
  .array(AgentMessageAttachment)
  .min(1)
  .max(MAX_MESSAGE_ATTACHMENTS)
  .superRefine((attachments, context) => {
    const ids = new Set<string>();
    for (const [index, attachment] of attachments.entries()) {
      if (ids.has(attachment.id)) {
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: "attachment ids must be unique",
        });
      }
      ids.add(attachment.id);
    }
  });

export type AgentMessageAttachmentRange = {
  attachment: AgentMessageAttachment;
  display: string;
  from: number;
  to: number;
};

export type DecodedAgentMessage = {
  attachments: AgentMessageAttachment[];
  references: AgentMessageAttachmentRange[];
  text: string;
};

export type AgentMessageDraft = {
  content: string;
  attachments: AgentMessageAttachment[];
};

/**
 * Decode the Markdown-like attachment links in `content`. The readable label
 * remains the fallback for consumers which only understand strings. Invalid
 * or dangling links reject the attachment metadata without hiding content.
 */
export function decodeAgentMessageAttachments(
  content: string,
  input: unknown,
): DecodedAgentMessage | null {
  const parsed = AgentMessageAttachments.safeParse(input);
  if (!parsed.success) return null;

  const byId = new Map(parsed.data.map((attachment) => [attachment.id, attachment]));
  const referencedIds = new Set<string>();
  const references: AgentMessageAttachmentRange[] = [];
  let text = "";
  let contentOffset = 0;

  for (const match of content.matchAll(ATTACHMENT_LINK_PATTERN)) {
    const matched = match[0];
    const escapedDisplay = match[1];
    const attachmentId = match[2];
    const matchIndex = match.index;
    if (matched === undefined || escapedDisplay === undefined || attachmentId === undefined) {
      return null;
    }
    const attachment = byId.get(attachmentId);
    if (attachment === undefined) return null;

    text += content.slice(contentOffset, matchIndex);
    const display = escapedDisplay.replaceAll(/\\(.)/g, "$1");
    const from = text.length;
    text += display;
    references.push({ attachment, display, from, to: text.length });
    referencedIds.add(attachmentId);
    contentOffset = matchIndex + matched.length;
  }

  if (referencedIds.size !== parsed.data.length) return null;
  text += content.slice(contentOffset);
  return { attachments: parsed.data, references, text };
}

export function emptyAgentMessageDraft(text = ""): AgentMessageDraft {
  return { content: text, attachments: [] };
}

export function agentMessageToEditorDocument(message: AgentMessageDraft): {
  text: string;
  references: AgentMessageAttachmentRange[];
} {
  if (message.attachments.length === 0) return { text: message.content, references: [] };
  const decoded = decodeAgentMessageAttachments(message.content, message.attachments);
  return decoded === null
    ? { text: message.content, references: [] }
    : { text: decoded.text, references: decoded.references };
}

/** Encode editor text and its semantic ranges as readable inline links. */
export function agentMessageFromEditorDocument(
  text: string,
  references: readonly AgentMessageAttachmentRange[],
): AgentMessageDraft {
  const content: string[] = [];
  const attachments: AgentMessageAttachment[] = [];
  const attachmentIds = new Set<string>();
  let offset = 0;

  for (const reference of references.toSorted((left, right) => left.from - right.from)) {
    if (
      reference.from < offset ||
      reference.to <= reference.from ||
      reference.to > text.length ||
      text.slice(reference.from, reference.to) !== reference.display
    ) {
      continue;
    }
    content.push(text.slice(offset, reference.from));
    content.push(agentMessageAttachmentLink(reference.display, reference.attachment.id));
    if (!attachmentIds.has(reference.attachment.id)) {
      attachments.push(reference.attachment);
      attachmentIds.add(reference.attachment.id);
    }
    offset = reference.to;
  }
  content.push(text.slice(offset));
  return { content: content.join(""), attachments };
}

export function agentMessageAttachmentLink(display: string, attachmentId: string): string {
  const escapedDisplay = display
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
  return `[${escapedDisplay}](${ATTACHMENT_DESTINATION_PREFIX}${attachmentId})`;
}

export function configRepoFileAttachmentId(path: string): string {
  return `config-repo/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function agentMessageAttachmentId(target: AgentMessageAttachmentTarget): string {
  switch (target.type) {
    case "repo-file":
      return configRepoFileAttachmentId(target.path);
  }
}

export function hasAgentConfigRepoFileAttachments(
  attachments: readonly AgentMessageAttachment[],
): boolean {
  return attachments.some((attachment) => attachment.type === "repo-file");
}

function isCanonicalRepoFilePath(path: string): boolean {
  if (
    path !== path.trim() ||
    path.startsWith("/") ||
    path.startsWith(".git/") ||
    path.includes("\0")
  ) {
    return false;
  }
  return !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}
