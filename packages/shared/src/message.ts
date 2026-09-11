import { z } from "zod";

const MENTION_DESTINATION_PREFIX = "mention://";
const MENTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~%:/-]*$/;
const MENTION_LINK_PATTERN =
  /\[((?:\\.|[^\\\]])*)\]\(mention:\/\/([A-Za-z0-9][A-Za-z0-9._~%:/-]*)\)/g;
const MAX_MESSAGE_MENTIONS = 100;

export const ConfigRepoFileMentionTarget = z.strictObject({
  type: z.literal("repo-file"),
  repoPath: z.literal("/repos/config"),
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine(isCanonicalRepoFilePath, "must be a canonical repository file path"),
});
export type ConfigRepoFileMentionTarget = z.infer<typeof ConfigRepoFileMentionTarget>;

/** A resource which can be linked from an agent message. Add future kinds here. */
export const MentionTarget = z.discriminatedUnion("type", [ConfigRepoFileMentionTarget]);
export type MentionTarget = z.infer<typeof MentionTarget>;

export const Mention = z
  .strictObject({
    id: z.string().max(8192).regex(MENTION_ID_PATTERN, "must be safe in a mention link"),
    ...ConfigRepoFileMentionTarget.shape,
  })
  .superRefine((mention, context) => {
    let expectedId: string;
    try {
      expectedId = messageMentionId(mention);
    } catch {
      context.addIssue({
        code: "custom",
        path: ["path"],
        message: "must contain valid Unicode",
      });
      return;
    }
    if (mention.id !== expectedId) {
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: "must identify the mentioned resource",
      });
    }
  });
/** A typed resource identified by a mention:// link in message content. */
export type Mention = z.infer<typeof Mention>;

export const MessageMentions = z
  .array(Mention)
  .max(MAX_MESSAGE_MENTIONS)
  .superRefine((mentions, context) => {
    const ids = new Set<string>();
    for (const [index, mention] of mentions.entries()) {
      if (ids.has(mention.id)) {
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: "mention ids must be unique",
        });
      }
      ids.add(mention.id);
    }
  });

export type MessageMentionRange = {
  mention: Mention;
  display: string;
  from: number;
  to: number;
};

export type DecodedAgentMessage = {
  mentions: Mention[];
  ranges: MessageMentionRange[];
  text: string;
};

/** Readable message content with optional resources addressed by inline mention:// links. */
export type Message = {
  content: string;
  mentions?: Mention[];
};

/**
 * Decode the Markdown-like mention links in `content`. The readable label
 * remains the fallback for consumers which only understand strings. Invalid
 * or dangling links reject the mention metadata without hiding content.
 */
export function decodeMessageMentions(content: string, input: unknown): DecodedAgentMessage | null {
  const parsed = MessageMentions.safeParse(input);
  if (!parsed.success) return null;

  const byId = new Map(parsed.data.map((mention) => [mention.id, mention]));
  const mentionedIds = new Set<string>();
  const ranges: MessageMentionRange[] = [];
  let text = "";
  let contentOffset = 0;

  for (const match of content.matchAll(MENTION_LINK_PATTERN)) {
    const matched = match[0];
    const escapedDisplay = match[1];
    const mentionId = match[2];
    const matchIndex = match.index;
    if (matched === undefined || escapedDisplay === undefined || mentionId === undefined) {
      return null;
    }
    const mention = byId.get(mentionId);
    if (mention === undefined) return null;

    text += content.slice(contentOffset, matchIndex);
    const display = escapedDisplay.replaceAll(/\\(.)/g, "$1");
    const from = text.length;
    text += display;
    ranges.push({ mention, display, from, to: text.length });
    mentionedIds.add(mentionId);
    contentOffset = matchIndex + matched.length;
  }

  if (mentionedIds.size !== parsed.data.length) return null;
  text += content.slice(contentOffset);
  return { mentions: parsed.data, ranges, text };
}

export function emptyMessage(text = ""): Message {
  return { content: text };
}

export function agentMessageToEditorDocument(message: Message): {
  text: string;
  mentions: MessageMentionRange[];
} {
  if (!message.mentions?.length) return { text: message.content, mentions: [] };
  const decoded = decodeMessageMentions(message.content, message.mentions);
  return decoded === null
    ? { text: message.content, mentions: [] }
    : { text: decoded.text, mentions: decoded.ranges };
}

/** Encode editor text and its semantic ranges as readable inline links. */
export function agentMessageFromEditorDocument(
  text: string,
  ranges: readonly MessageMentionRange[],
): Message {
  const content: string[] = [];
  const mentions: Mention[] = [];
  const mentionIds = new Set<string>();
  let offset = 0;

  for (const mention of ranges.toSorted((left, right) => left.from - right.from)) {
    if (
      mention.from < offset ||
      mention.to <= mention.from ||
      mention.to > text.length ||
      text.slice(mention.from, mention.to) !== mention.display
    ) {
      continue;
    }
    content.push(text.slice(offset, mention.from));
    content.push(messageMentionLink(mention.display, mention.mention.id));
    if (!mentionIds.has(mention.mention.id)) {
      mentions.push(mention.mention);
      mentionIds.add(mention.mention.id);
    }
    offset = mention.to;
  }
  content.push(text.slice(offset));
  return { content: content.join(""), ...(mentions.length === 0 ? {} : { mentions }) };
}

export function messageMentionLink(display: string, mentionId: string): string {
  const escapedDisplay = display
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
  return `[${escapedDisplay}](${MENTION_DESTINATION_PREFIX}${mentionId})`;
}

export function configRepoFileMentionId(path: string): string {
  return `config-repo/${path
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replaceAll(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/")}`;
}

export function messageMentionId(target: MentionTarget): string {
  switch (target.type) {
    case "repo-file":
      return configRepoFileMentionId(target.path);
  }
}

export function hasConfigRepoFileMentions(mentions: readonly Mention[]): boolean {
  return mentions.some((mention) => mention.type === "repo-file");
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
