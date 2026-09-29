import type { Principal } from "iterate/principal";

/** A commit's author for the person signed in: their email as both name and address. Without an
 *  email, none: the repo writes its own default. */
export function authorOf(principal: Principal) {
  return principal.email ? { name: principal.email, email: principal.email } : undefined;
}
