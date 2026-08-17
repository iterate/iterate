import { isValidAuthor } from "iterate/annotated-markdown";
import type { CommentIdentity } from "./types.ts";

/**
 * Stable annotation identity for a platform user: an attribute-safe author
 * token plus an optional human-facing display name.
 */
export function commentIdentityFor(user: {
  email: string | null;
  name: string | null;
  userId: string | null;
}): CommentIdentity {
  const author =
    user.email !== null && isValidAuthor(user.email)
      ? user.email
      : slug(user.name ?? user.userId ?? "") || "someone";
  const authorDisplay = user.name ?? user.email ?? undefined;
  return authorDisplay === undefined ? { author } : { author, authorDisplay };
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
