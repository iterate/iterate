/** The scopes the dash asks for at sign-in. `account` and `organizations:write` are optional at
 *  consent; the pages read `info.scopes` for what was granted. */
export const dashScopes = ["iterate", "account", "organizations:write"];

/** A step-up link: `/.auth/login` asked for the dash's scopes again re-consents a person who
 *  unticked some (it bounces a session that already holds them) and lands them back on `next`. */
export const stepUpUrl = (next: string) =>
  `/.auth/login?${new URLSearchParams({ next, scope: dashScopes.join(" ") })}`;
