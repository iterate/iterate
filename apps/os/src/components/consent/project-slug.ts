/** A slug as it is typed: `projectSlug` (control-plane/catalog.ts) without collapsing dashes or
 *  trimming the ends, so a dash just typed survives until the next word follows it. */
export function typedSlug(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}
