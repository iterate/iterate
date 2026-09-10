export const MAX_HIGHLIGHTED_SCRIPT_RESULT_CHARACTERS = 64 * 1024;

/**
 * CodeMirror is useful for ordinary structured results but becomes expensive
 * near the stream event-size ceiling. Return a bounded plain-text preview only
 * when the serialized value is too large for the rich renderer.
 */
export function oversizedScriptResultPreview(
  value: unknown,
  maxCharacters = MAX_HIGHLIGHTED_SCRIPT_RESULT_CHARACTERS,
): { preview: string; totalCharacters: number } | null {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined || serialized.length <= maxCharacters) return null;
  return {
    preview: serialized.slice(0, maxCharacters),
    totalCharacters: serialized.length,
  };
}
