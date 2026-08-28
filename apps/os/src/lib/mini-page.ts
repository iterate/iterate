import { z } from "zod";

// Mini pages: the chrome-free, one-job pages a native client opens in an
// in-app browser sheet instead of handing to the system browser, so the user
// never leaves the app. `/collect-secret/$projectSlug` is the first; ad-hoc
// "answer these three questions" pages are the reason this contract is
// generic rather than living inside that route.
//
// The whole contract is two things:
//
// 1. The page accepts a `returnTo` search param — a deep link into the client
//    that opened it.
// 2. When its job is done, the page navigates to that link with the outcome
//    in its search params.
//
// The native side needs nothing else: iOS's auth-session browser dismisses
// itself the moment the page navigates to the app's own scheme, and hands the
// URL back, so the client learns both "we're finished" and "how it went"
// without knowing what the page collected.

/** Search params every mini page accepts, on top of its own. */
export const MiniPageSearch = z.object({
  /** Deep link the page navigates to when its job is done — how the client's
   * in-app browser knows to close. Absent for ordinary web visits, which just
   * see the page's own done state. */
  returnTo: z.string().optional(),
});
export type MiniPageSearch = z.infer<typeof MiniPageSearch>;

/**
 * Schemes a mini page may return to. Native app schemes only: this is a
 * redirect out of a signed-in page, and `returnTo` rides in a link anyone can
 * write, so allowing `https:` would turn every mini page into an open
 * redirect — the shape phishing wants ("os.iterate.com sent me here").
 * `iterate:` is the app; `exp:` is the same app under an Expo Go dev client.
 */
const RETURNABLE_SCHEMES = ["iterate:", "exp:"];

/**
 * Where a finished mini page should navigate, or null when there is nowhere
 * to go (no `returnTo`, or one pointing somewhere we will not send a user).
 * `outcome` params ride along so the client learns how it went — the
 * secret page sends `status`; another page might send whatever it collected
 * that is not itself sensitive.
 */
export function miniPageReturnUrl(
  returnTo: string | undefined,
  outcome: Record<string, string>,
): string | null {
  if (returnTo === undefined) return null;
  let url: URL;
  try {
    url = new URL(returnTo);
  } catch {
    return null;
  }
  if (!RETURNABLE_SCHEMES.includes(url.protocol)) return null;
  for (const [key, value] of Object.entries(outcome)) url.searchParams.set(key, value);
  return url.toString();
}
