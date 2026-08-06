// Markdown → plain text for push-notification bodies. iOS notifications have
// no inline rich text at all (the bold line in a push is the TITLE's own
// styling), so markers can only ever render literally — `**Berlin**` on a
// lock screen. Flattening is deliberately conservative: unwrap what certainly
// reads better without markers, leave anything ambiguous alone (mangling a
// reply is worse than showing a stray asterisk).
export function markdownToPlainText(markdown: string): string {
  let text = markdown;
  // Code fences: keep the inner lines, drop the ``` rails (language tag too).
  text = text.replaceAll(/^```[^\n]*\n([\s\S]*?)\n?```\s*$/gm, "$1");
  // Images before links (same bracket syntax): an image IS its alt text.
  text = text.replaceAll(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replaceAll(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Inline code.
  text = text.replaceAll(/`([^`\n]+)`/g, "$1");
  // Emphasis, longest markers first so ** doesn't half-match as *. Content
  // must not begin or end with whitespace (markdown's own rule) — that is
  // what keeps arithmetic like `3 * 4 * 5` intact. The underscore variants
  // additionally require non-word boundaries: snake_case_names must survive.
  text = text.replaceAll(/\*\*(\S(?:[^*\n]*\S)?)\*\*/g, "$1");
  text = text.replaceAll(/(?<!\w)__(\S(?:[^_\n]*\S)?)__(?!\w)/g, "$1");
  text = text.replaceAll(/~~(\S(?:[^~\n]*\S)?)~~/g, "$1");
  text = text.replaceAll(/\*(\S(?:[^*\n]*\S)?)\*/g, "$1");
  text = text.replaceAll(/(?<!\w)_(\S(?:[^_\n]*\S)?)_(?!\w)/g, "$1");
  // Per-line prefixes: headings and blockquotes drop their markers; * and +
  // bullets normalize to the hyphen iOS renders most legibly. Numbered lists
  // and hyphen bullets already read fine.
  text = text.replaceAll(/^#{1,6}\s+/gm, "");
  text = text.replaceAll(/^(\s*)>\s?/gm, "$1");
  text = text.replaceAll(/^(\s*)[*+]\s+/gm, "$1- ");
  // Horizontal rules carry no text.
  text = text.replaceAll(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "");
  // Collapse the blank runs the removals leave behind.
  text = text.replaceAll(/\n{3,}/g, "\n\n");
  return text.trim();
}
