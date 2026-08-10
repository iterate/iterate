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

// ---------------------------------------------------------------------------
// Recommendation vs phone state: what differs, and the one tap that fixes it.
// Pure on purpose (no Expo imports) — the node vitest lane covers every branch.
// ---------------------------------------------------------------------------

export type RecommendedServer = { baseUrl: string; label: string };

/** What the QR recommends. `server` is null when the env param was absent or
 * didn't resolve to a preset; `email` is the (already validated) test
 * identity or null. */
export type Recommendation = { server: RecommendedServer | null; email: string | null };

/** What the phone is actually doing. `email` is the current server's
 * signed-in identity (null = signed out / no claim); `recommendedServerEmail`
 * is the same thing for the RECOMMENDED server — equal to `email` when
 * they're the same server, and what a backend switch would land on when not. */
export type PhoneState = {
  serverBaseUrl: string;
  email: string | null;
  recommendedServerEmail: string | null;
};

export type Mismatch =
  | { kind: "backend"; current: string; recommended: RecommendedServer }
  | { kind: "identity"; current: string | null; recommended: string };

/**
 * What differs between the phone and the QR's recommendation. Empty without a
 * recommended server: an email hint alone is unusable (the test OTP only
 * exists on the hinted env, and without `env` we don't know which that is) —
 * matching the sign-in screen's refusal to login_hint anywhere else. When the
 * backend differs, the identity comparison looks at the RECOMMENDED server's
 * sign-in — that's what a switch would land on.
 */
export function recommendationMismatches(phone: PhoneState, qr: Recommendation): Mismatch[] {
  if (qr.server === null) return [];
  const mismatches: Mismatch[] = [];
  const backendDiffers = qr.server.baseUrl !== phone.serverBaseUrl;
  if (backendDiffers) {
    mismatches.push({ kind: "backend", current: phone.serverBaseUrl, recommended: qr.server });
  }
  if (qr.email !== null) {
    const landing = backendDiffers ? phone.recommendedServerEmail : phone.email;
    if (landing === null || landing.toLowerCase() !== qr.email.toLowerCase()) {
      mismatches.push({ kind: "identity", current: landing, recommended: qr.email });
    }
  }
  return mismatches;
}

export type SwitchPlan =
  /** Already signed in (acceptably) on the recommended server — repoint, no OAuth. */
  | { type: "use-server"; baseUrl: string; label: string }
  /** Sign in on the recommended server, as the test identity when hinted. */
  | { type: "sign-in"; baseUrl: string; label: string; loginHint: string | null };

/** The single tap that brings the phone in line with the QR, or null when
 * nothing differs (or there's nothing actionable to differ from). */
export function recommendationSwitchPlan(phone: PhoneState, qr: Recommendation): SwitchPlan | null {
  const mismatches = recommendationMismatches(phone, qr);
  if (qr.server === null || mismatches.length === 0) return null;
  const { baseUrl, label } = qr.server;
  if (mismatches.some((m) => m.kind === "identity")) {
    return { type: "sign-in", baseUrl, label, loginHint: qr.email };
  }
  // Backend is the only difference. A sign-in already parked on the
  // recommended server makes this a pure repoint; otherwise OAuth it is.
  return phone.recommendedServerEmail !== null
    ? { type: "use-server", baseUrl, label }
    : { type: "sign-in", baseUrl, label, loginHint: qr.email };
}
