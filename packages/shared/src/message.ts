import { z } from "zod";

const REFERENCE_DESTINATION_PREFIX = "ref://";
const REFERENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~%:/-]*$/;
const REFERENCE_LINK_PATTERN =
  /\[((?:\\.|[^\\\]])*)\]\(ref:\/\/([A-Za-z0-9][A-Za-z0-9._~%:/-]*)\)/g;
const MAX_MESSAGE_REFERENCES = 100;

export const ConfigRepoFileReferenceTarget = z.strictObject({
  type: z.literal("repo-file"),
  repoPath: z.literal("/repos/config"),
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine(isCanonicalRepoFilePath, "must be a canonical repository file path"),
});
export type ConfigRepoFileReferenceTarget = z.infer<typeof ConfigRepoFileReferenceTarget>;

/** A resource which can be linked from an agent message. Add future kinds here. */
export const ReferenceTarget = z.discriminatedUnion("type", [ConfigRepoFileReferenceTarget]);
export type ReferenceTarget = z.infer<typeof ReferenceTarget>;

export const Reference = z
  .strictObject({
    id: z.string().max(8192).regex(REFERENCE_ID_PATTERN, "must be safe in a reference link"),
    ...ConfigRepoFileReferenceTarget.shape,
  })
  .superRefine((reference, context) => {
    let expectedId: string;
    try {
      expectedId = messageReferenceId(reference);
    } catch {
      context.addIssue({
        code: "custom",
        path: ["path"],
        message: "must contain valid Unicode",
      });
      return;
    }
    if (reference.id !== expectedId) {
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: "must identify the referenced resource",
      });
    }
  });
/** A typed resource identified by a ref:// link in message content. */
export type Reference = z.infer<typeof Reference>;

export const MessageReferences = z
  .array(Reference)
  .max(MAX_MESSAGE_REFERENCES)
  .superRefine((references, context) => {
    const ids = new Set<string>();
    for (const [index, reference] of references.entries()) {
      if (ids.has(reference.id)) {
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: "reference ids must be unique",
        });
      }
      ids.add(reference.id);
    }
  });

export type MessageReferenceRange = {
  reference: Reference;
  display: string;
  from: number;
  to: number;
};

export type DecodedAgentMessage = {
  references: Reference[];
  ranges: MessageReferenceRange[];
  text: string;
};

/** Readable message content with optional resources addressed by inline ref:// links. */
export type Message = {
  content: string;
  references?: Reference[];
};

/**
 * Decode the Markdown-like reference links in `content`. The readable label
 * remains the fallback for consumers which only understand strings. Invalid
 * or dangling links reject the reference metadata without hiding content.
 */
export function decodeMessageReferences(
  content: string,
  input: unknown,
): DecodedAgentMessage | null {
  const parsed = MessageReferences.safeParse(input);
  if (!parsed.success) return null;

  const byId = new Map(parsed.data.map((reference) => [reference.id, reference]));
  const referencedIds = new Set<string>();
  const ranges: MessageReferenceRange[] = [];
  let text = "";
  let contentOffset = 0;

  for (const match of content.matchAll(REFERENCE_LINK_PATTERN)) {
    const matched = match[0];
    const escapedDisplay = match[1];
    const referenceId = match[2];
    const matchIndex = match.index;
    if (matched === undefined || escapedDisplay === undefined || referenceId === undefined) {
      return null;
    }
    const reference = byId.get(referenceId);
    if (reference === undefined) return null;

    text += content.slice(contentOffset, matchIndex);
    const display = escapedDisplay.replaceAll(/\\(.)/g, "$1");
    const from = text.length;
    text += display;
    ranges.push({ reference, display, from, to: text.length });
    referencedIds.add(referenceId);
    contentOffset = matchIndex + matched.length;
  }

  if (referencedIds.size !== parsed.data.length) return null;
  text += content.slice(contentOffset);
  return { references: parsed.data, ranges, text };
}

export function emptyMessage(text = ""): Message {
  return { content: text };
}

export function agentMessageToEditorDocument(message: Message): {
  text: string;
  references: MessageReferenceRange[];
} {
  if (!message.references?.length) return { text: message.content, references: [] };
  const decoded = decodeMessageReferences(message.content, message.references);
  return decoded === null
    ? { text: message.content, references: [] }
    : { text: decoded.text, references: decoded.ranges };
}

/** Encode editor text and its semantic ranges as readable inline links. */
export function agentMessageFromEditorDocument(
  text: string,
  ranges: readonly MessageReferenceRange[],
): Message {
  const content: string[] = [];
  const references: Reference[] = [];
  const referenceIds = new Set<string>();
  let offset = 0;

  for (const reference of ranges.toSorted((left, right) => left.from - right.from)) {
    if (
      reference.from < offset ||
      reference.to <= reference.from ||
      reference.to > text.length ||
      text.slice(reference.from, reference.to) !== reference.display
    ) {
      continue;
    }
    content.push(text.slice(offset, reference.from));
    content.push(messageReferenceLink(reference.display, reference.reference.id));
    if (!referenceIds.has(reference.reference.id)) {
      references.push(reference.reference);
      referenceIds.add(reference.reference.id);
    }
    offset = reference.to;
  }
  content.push(text.slice(offset));
  return { content: content.join(""), ...(references.length === 0 ? {} : { references }) };
}

export function messageReferenceLink(display: string, referenceId: string): string {
  const escapedDisplay = display
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
  return `[${escapedDisplay}](${REFERENCE_DESTINATION_PREFIX}${referenceId})`;
}

export function configRepoFileReferenceId(path: string): string {
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

export function messageReferenceId(target: ReferenceTarget): string {
  switch (target.type) {
    case "repo-file":
      return configRepoFileReferenceId(target.path);
  }
}

export function hasConfigRepoFileReferences(references: readonly Reference[]): boolean {
  return references.some((reference) => reference.type === "repo-file");
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
