// ---------------------------------------------------------------------------
// Prompt Fragment Zod Schemas (mirrors structures in prompt-fragments.ts)
// ---------------------------------------------------------------------------

import { z } from "zod";

export type PromptFragment =
  | null
  | string
  | { tag?: string; content: PromptFragment | PromptFragment[] }
  | PromptFragment[];

// Forward declaration for recursion
// A PromptFragment can be: null, string, object (with tag/content), or array of PromptFragments (recursive)
export const PromptFragment: z.ZodType<PromptFragment> = z.lazy(() =>
  z.union([
    z.null(),
    z.string(),
    z.object({
      tag: z.string().optional(),
      content: PromptFragment,
    }),
    z.array(PromptFragment),
  ]),
);

export function renderPromptFragment(
  fragment: PromptFragment | PromptFragment[],
  indentLevel = 0,
): string {
  if (!fragment) {
    return "";
  }

  if (Array.isArray(fragment)) {
    const renderedItems = fragment
      .filter((f) => f != null)
      .map((f) => renderPromptFragment(f, indentLevel))
      .filter((rendered) => rendered && rendered.trim().length > 0);

    if (renderedItems.length === 0) {
      return "";
    }

    return renderedItems.join("\n\n");
  }

  // Base indentation for the current level
  const indent = "  ".repeat(indentLevel);

  // For string fragments, just return with appropriate indentation
  if (typeof fragment === "string") {
    // Don't indent at level 0
    if (indentLevel === 0) {
      return fragment;
    }

    // Otherwise indent each line
    return fragment
      .split("\n")
      .map((line) => (line ? `${indent}${line}` : line))
      .join("\n");
  }

  // For objects with tag, content gets indented one more level
  const contentIndentLevel = fragment.tag ? indentLevel + 1 : indentLevel;
  const contentIndent = "  ".repeat(contentIndentLevel);

  // Process content based on type
  let content: PromptFragment;
  if (Array.isArray(fragment.content)) {
    // Handle empty arrays
    if (fragment.content.length === 0) {
      content = "";
    } else {
      // For array content, process each item, filter out empty results, and join with double newline
      const renderedItems = fragment.content
        .filter((f): f is PromptFragment => f != null)
        .map((f) => renderPromptFragment(f, contentIndentLevel))
        .filter((rendered) => rendered && rendered.trim().length > 0);

      if (renderedItems.length === 0) {
        content = "";
      } else {
        content = renderedItems.join("\n\n");
      }
    }
  } else if (fragment.content) {
    // For string content, just use the string directly
    content = renderPromptFragment(fragment.content);

    // Apply indentation to string content if needed
    if (contentIndentLevel > 0) {
      content = content
        .split("\n")
        .map((line) => (line ? `${contentIndent}${line}` : line))
        .join("\n");
    }
  } else {
    content = "";
  }

  // If there's a tag, wrap the content with the tag
  if (fragment.tag) {
    // If content is empty or only whitespace, return empty string to filter out empty fragments
    if (!content || content.trim().length === 0) {
      return "";
    }
    return `${indent}<${fragment.tag}>\n${content}\n${indent}</${fragment.tag}>`;
  }

  // If content is empty or only whitespace, return empty string
  if (!content || content.trim().length === 0) {
    return "";
  }

  return content;
}

/**
 * Create a prompt fragment with an optional XML tag wrapper.
 * This is a utility function for creating structured prompt fragments.
 *
 * @param tag - The XML tag name to wrap the content
 * @param content - The fragment content(s) - can be strings, objects, or arrays
 * @returns A PromptFragmentObject with the specified tag and content
 *
 * @example
 * // Simple fragment
 * f("role", "You are a helpful assistant")
 *
 * // Nested fragments
 * f("rules",
 *   "Follow these guidelines:",
 *   f("important", "Be concise"),
 *   f("important", "Be accurate")
 * )
 */
export function f(tag: string, ...content: PromptFragment[]): z.infer<typeof PromptFragment> {
  return { tag, content };
}
