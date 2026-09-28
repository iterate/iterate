// integration-scopes.ts — WHAT A PERSON'S ACCOUNT LACKS for a project, the one rule the platform
// (`itx.integrations.connect(provider, { account })`) and the Dash's Connect sheet both apply.

/** Google's short names for its identity scopes, which a sign-in asks for and a token response may
 *  answer in either spelling. */
const GOOGLE_SCOPE_ALIASES: Record<string, string> = {
  email: "https://www.googleapis.com/auth/userinfo.email",
  profile: "https://www.googleapis.com/auth/userinfo.profile",
};

/** The scopes `asked` that `granted` does not hold, in the order asked — none means the account is
 *  connected at once, any means an incremental consent on the person's own connection first. Google
 *  spells `email` and `profile` two ways; every other scope is compared as written. */
export function missingScopes(
  provider: string,
  granted: readonly string[],
  asked: readonly string[],
) {
  const spelled = (scope: string) =>
    provider === "google" ? GOOGLE_SCOPE_ALIASES[scope] || scope : scope;
  const held = new Set(granted.map(spelled));
  return [...new Set(asked)].filter((scope) => !held.has(spelled(scope)));
}
