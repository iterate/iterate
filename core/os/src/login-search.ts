import { z } from "zod";

const optionalString = z.string().optional().catch(undefined);

/** Query parameters the sign-in page carries across server renders and form redirects. Anything
 *  else, or a value that is not a string, is dropped rather than refused. */
const LoginSearch = z
  .object({
    next: optionalString,
    error: optionalString,
    email: optionalString,
    method: optionalString,
    /** which way to sign in a link suggests (`google`, `github`, `cloudflare`, or the admin
     *  issuer's host): the page leads with it (login.server.ts) */
    provider_hint: optionalString,
  })
  .catch({});

export const loginSearchOf = (search: unknown) => LoginSearch.parse(search);

/** Sign in first, and come back to `next`; with `providerHint`, the page leads with that way to
 *  sign in. */
export function signInHref(next: string, providerHint: string | null) {
  const query = new URLSearchParams({ next });
  if (providerHint) query.set("provider_hint", providerHint);
  return `/login?${query}`;
}

/** Sign out, then sign in as someone else and come back to `next`. */
export function switchAccountHref(next: string) {
  return `/.auth/logout?${new URLSearchParams({ next: signInHref(next, null) })}`;
}
