import { z } from "zod";

export const AgentConfigRepoFileReferenceTarget = z.strictObject({
  kind: z.literal("config-repo-file"),
  repoPath: z.literal("/repos/config"),
  path: z
    .string()
    .min(1)
    .refine(isCanonicalRepoFilePath, "must be a canonical repository file path"),
});
export type AgentConfigRepoFileReferenceTarget = z.infer<typeof AgentConfigRepoFileReferenceTarget>;

/** A durable reference identity. Add future target kinds to this union. */
export const AgentReferenceTarget = z.discriminatedUnion("kind", [
  AgentConfigRepoFileReferenceTarget,
]);
export type AgentReferenceTarget = z.infer<typeof AgentReferenceTarget>;

const AgentRichContentNode = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string() }),
  z.strictObject({
    type: z.literal("reference"),
    occurrenceId: z.string().min(1),
    display: z.string().min(1),
    target: AgentReferenceTarget,
  }),
]);

/** Versioned semantic document stored beside its required plain-text projection. */
export const AgentRichContentV1 = z
  .strictObject({
    version: z.literal(1),
    nodes: z.array(AgentRichContentNode),
  })
  .superRefine((document, context) => {
    const occurrenceIds = new Set<string>();
    for (const [index, node] of document.nodes.entries()) {
      if (node.type !== "reference") continue;
      if (occurrenceIds.has(node.occurrenceId)) {
        context.addIssue({
          code: "custom",
          path: ["nodes", index, "occurrenceId"],
          message: "reference occurrence ids must be unique",
        });
      }
      occurrenceIds.add(node.occurrenceId);
    }
  });
export type AgentRichContentV1 = z.infer<typeof AgentRichContentV1>;
export type AgentRichContentNode = AgentRichContentV1["nodes"][number];
export type AgentRichContentReferenceNode = Extract<AgentRichContentNode, { type: "reference" }>;

export type AgentRichContentReferenceRange = AgentRichContentReferenceNode & {
  from: number;
  to: number;
};

export type AgentContextRepoFileRef = {
  type: "repo-file";
  repoPath: "/repos/config";
  path: string;
};

export function flattenAgentRichContent(document: AgentRichContentV1): string {
  return document.nodes.map((node) => (node.type === "text" ? node.text : node.display)).join("");
}

/**
 * Decode only a known document whose projection exactly matches `content`.
 * Callers keep rendering `content` when this returns null, so unknown future
 * versions and malformed metadata can never make a message disappear.
 */
export function decodeAgentRichContent(content: string, input: unknown): AgentRichContentV1 | null {
  const parsed = AgentRichContentV1.safeParse(input);
  if (!parsed.success || flattenAgentRichContent(parsed.data) !== content) return null;
  return parsed.data;
}

export function plainAgentRichContent(text = ""): AgentRichContentV1 {
  return text === "" ? { version: 1, nodes: [] } : { version: 1, nodes: [{ type: "text", text }] };
}

export function agentRichContentToEditorDocument(document: AgentRichContentV1): {
  text: string;
  references: AgentRichContentReferenceRange[];
} {
  let offset = 0;
  const references: AgentRichContentReferenceRange[] = [];
  for (const node of document.nodes) {
    const value = node.type === "text" ? node.text : node.display;
    if (node.type === "reference") {
      references.push({ ...node, from: offset, to: offset + value.length });
    }
    offset += value.length;
  }
  return { text: flattenAgentRichContent(document), references };
}

/** Encode editor text and its non-overlapping semantic ranges into wire nodes. */
export function agentRichContentFromEditorDocument(
  text: string,
  references: readonly AgentRichContentReferenceRange[],
): AgentRichContentV1 {
  const nodes: AgentRichContentNode[] = [];
  let offset = 0;
  const ordered = references.toSorted((left, right) => left.from - right.from);
  for (const reference of ordered) {
    if (
      reference.from < offset ||
      reference.to <= reference.from ||
      reference.to > text.length ||
      text.slice(reference.from, reference.to) !== reference.display
    ) {
      continue;
    }
    if (reference.from > offset) {
      nodes.push({ type: "text", text: text.slice(offset, reference.from) });
    }
    nodes.push({
      type: "reference",
      occurrenceId: reference.occurrenceId,
      display: reference.display,
      target: reference.target,
    });
    offset = reference.to;
  }
  if (offset < text.length) nodes.push({ type: "text", text: text.slice(offset) });
  return { version: 1, nodes };
}

/** Project unique server coordinates; repeated pills remain distinct in the document. */
export function deriveAgentContextRepoFileRefs(
  document: AgentRichContentV1,
): AgentContextRepoFileRef[] {
  const refs: AgentContextRepoFileRef[] = [];
  const seen = new Set<string>();
  for (const node of document.nodes) {
    if (node.type !== "reference" || node.target.kind !== "config-repo-file") continue;
    const key = `${node.target.repoPath}\0${node.target.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ type: "repo-file", repoPath: node.target.repoPath, path: node.target.path });
  }
  return refs;
}

export function hasAgentConfigRepoFileReferences(document: AgentRichContentV1): boolean {
  return document.nodes.some(
    (node) => node.type === "reference" && node.target.kind === "config-repo-file",
  );
}

function isCanonicalRepoFilePath(path: string): boolean {
  if (path !== path.trim() || path.startsWith("/") || path.startsWith(".git/")) return false;
  return !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}
