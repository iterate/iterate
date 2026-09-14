import type { CommentIdentity } from "./types.ts";

/**
 * Stable review identity for a platform user. RFM stores authors as YAML
 * strings, so an email can remain the durable identity without tokenizing it.
 */
export function commentIdentityFor(user: {
  email: string | null;
  name: string | null;
  userId: string | null;
}): CommentIdentity {
  const author = user.email ?? user.userId ?? user.name ?? "someone";
  const authorDisplay = user.name ?? user.email ?? undefined;
  return authorDisplay === undefined ? { author } : { author, authorDisplay };
}
