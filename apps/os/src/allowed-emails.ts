// ── who may sign in ── `login.allowedEmails` (app-config.ts): the email patterns a deployment
// admits, each an address with `*` for any run of characters (`*@iterate.com`, `jonas@*`), matched
// whole and case-insensitively. Unset ⇒ every verified email. Checked at each sign-in before the
// person is found or created (identity.ts, password-and-code-sign-in.ts) and at every grant's
// admission and refresh (oauth.ts): a grant for an address the list no longer names stops working
// on its next request.

/** Whether `patterns` admit `email`; `undefined` (no list) admits everyone. */
export function emailAllowed(patterns: readonly string[] | undefined, email: string): boolean {
  if (!patterns) return true;
  const address = email.trim().toLowerCase();
  return patterns.some((pattern) => patternRegExpOf(pattern).test(address));
}

const regExpByPattern = new Map<string, RegExp>();

function patternRegExpOf(pattern: string): RegExp {
  let regExp = regExpByPattern.get(pattern);
  if (!regExp) {
    const source = pattern
      .trim()
      .toLowerCase()
      .split("*")
      .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    regExp = new RegExp(`^${source}$`, "s");
    regExpByPattern.set(pattern, regExp);
  }
  return regExp;
}

/** What a refused person reads on the sign-in page. */
export const EMAIL_NOT_ALLOWED_MESSAGE = "That email can't sign in here.";
