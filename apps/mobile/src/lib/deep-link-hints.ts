// The test-identity hint riding preview-channel deep links
// (iterate://preview-channel/<channel>?email=pr<N>%2Btest%40nustom.com).
//
// Why the space normalization: expo-router's NATIVE deep-link path extraction
// (fork/extractPathFromURL.js `fromDeepLink`) rebuilds the query string from
// already-decoded URLSearchParams values — `%2B` becomes a literal `+` — and
// its later param parse runs that through `new URL().searchParams`, where a
// bare `+` decodes as a SPACE. So on device the hint arrives as
// "pr2429 test@nustom.com". A space is impossible in a real email hint, so
// mapping it back to `+` is lossless. Web never double-decodes (no
// fromDeepLink) and is unaffected.
export function testEmailFromHint(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.replaceAll(" ", "+");
  return /\+test@nustom\.com$/i.test(email) ? email : null;
}
