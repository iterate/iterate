import type { ReactNode } from "react";

export type ComposerSuggestion = {
  id: string;
  /** Text shown in the result row. */
  label: string;
  /** Text inserted in place of the active trigger and query. */
  text: string;
  description?: string;
  icon?: ReactNode;
};

export type ComposerSuggestionProvider = {
  id: string;
  /** The text which starts this provider, such as `@` or `/`. */
  trigger: string;
  label: string;
  /** Provider-specific scope which prevents cross-project or cross-source cache collisions. */
  cacheKey: readonly unknown[];
  /** Return already-filtered, relevance-ordered suggestions for this query. */
  search: (query: string) => Promise<readonly ComposerSuggestion[]>;
};

export type ActiveComposerSuggestion = {
  provider: ComposerSuggestionProvider;
  query: string;
  from: number;
  to: number;
};

/**
 * Find the provider token which owns the caret. Triggers only start at a word
 * boundary, so an email address does not accidentally open the `@` provider.
 * Queries end at whitespace; this works for file paths and slash commands and
 * gives later providers one explicit parsing rule to replace if they need it.
 */
export function activeComposerSuggestion(
  value: string,
  caret: number,
  providers: readonly ComposerSuggestionProvider[],
): ActiveComposerSuggestion | null {
  const beforeCaret = value.slice(0, caret);
  let active: ActiveComposerSuggestion | null = null;

  for (const provider of providers) {
    if (provider.trigger === "") continue;
    const from = beforeCaret.lastIndexOf(provider.trigger);
    if (from < 0) continue;
    const preceding = value[from - 1];
    if (preceding !== undefined && !/\s/.test(preceding)) continue;

    const queryStart = from + provider.trigger.length;
    const query = value.slice(queryStart, caret);
    if (/\s/.test(query)) continue;

    let to = caret;
    while (to < value.length && !/\s/.test(value[to]!)) to += 1;
    if (active === null || from > active.from) active = { provider, query, from, to };
  }

  return active;
}

export function applyComposerSuggestion(
  value: string,
  active: ActiveComposerSuggestion,
  suggestion: ComposerSuggestion,
): { value: string; caret: number } {
  const after = value.slice(active.to);
  const separator = after === "" || !/^\s/.test(after) ? " " : "";
  const existingSeparatorLength = separator === "" && /^\s/.test(after) ? 1 : 0;
  const before = value.slice(0, active.from);
  const nextValue = `${before}${suggestion.text}${separator}${after}`;
  return {
    value: nextValue,
    caret: before.length + suggestion.text.length + separator.length + existingSeparatorLength,
  };
}
