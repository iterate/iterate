/** The directory's slugging as it is typed: lowercase, anything but a-z, 0-9 and dashes a dash. */
export function typedSlug(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

/** A slug proposed from a name: runs of dashes collapsed, its ends trimmed. */
export function proposedSlug(name: string) {
  return typedSlug(name)
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}
