// The running bundle's expectation: which backend this JS was published to
// talk to, and the test identity to offer signing in as. Stamped into
// build-info.json by CI at publish time (apps/mobile/scripts/
// write-build-info.mjs + scripts/ci/publish-mobile-pr-preview.ts), so it
// travels WITH the bundle — OTA switches, auto-pulled updates, and native
// installs all self-describe, and a main bundle (stamped empty) recommends
// nothing. Replaces the ?env=&email= deep-link params, which described the
// URL you scanned rather than the JS you're running.
//
// Pure on purpose (no Expo/RN imports) — the node vitest lane covers every
// branch. The AsyncStorage-backed once-per-bundle claim lives in
// new-bundle-boot.ts.
import { buildInfo } from "./build-info.ts";
import { serverPresetForEnvKey } from "./servers.ts";

/** Only per-PR test addresses are ever suggested; anything else stamped (or
 * corrupted) is dropped rather than offered as a sign-in identity. */
export function validatedTestEmail(raw: unknown): string | null {
  return typeof raw === "string" && /\+test@nustom\.com$/i.test(raw) ? raw : null;
}

export type RecommendedServer = { baseUrl: string; label: string };

/** What the bundle expects. `server` is null when the stamp is empty
 * (main/local bundles) or names an unknown env; `email` is the (already
 * validated) test identity or null. */
export type Recommendation = { server: RecommendedServer | null; email: string | null };

/**
 * The running bundle's recommendation. Resolution goes through the preset
 * list only (serverPresetForEnvKey), so a poisoned stamp can't point the app
 * — and its OAuth flow — at an arbitrary server. The email is only usable
 * alongside its own backend (the test OTP exists nowhere else), so it's null
 * whenever the server is.
 */
export function bundleRecommendation(): Recommendation {
  const server = buildInfo.expectedBackendEnv
    ? serverPresetForEnvKey(buildInfo.expectedBackendEnv)
    : null;
  return { server, email: server ? validatedTestEmail(buildInfo.testLoginEmail) : null };
}

// ---------------------------------------------------------------------------
// Recommendation vs phone state: what differs, and the one tap that fixes it.
// ---------------------------------------------------------------------------

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
 * What differs between the phone and the bundle's recommendation. Empty
 * without a recommended server: an email alone is unusable (the test OTP
 * only exists on the expected env, and without it we don't know which that
 * is) — matching the sign-in screen's refusal to login_hint anywhere else.
 * When the backend differs, the identity comparison looks at the RECOMMENDED
 * server's sign-in — that's what a switch would land on.
 */
export function recommendationMismatches(phone: PhoneState, rec: Recommendation): Mismatch[] {
  if (!rec.server) return [];
  const mismatches: Mismatch[] = [];
  const backendDiffers = rec.server.baseUrl !== phone.serverBaseUrl;
  if (backendDiffers) {
    mismatches.push({ kind: "backend", current: phone.serverBaseUrl, recommended: rec.server });
  }
  if (rec.email) {
    const landing = backendDiffers ? phone.recommendedServerEmail : phone.email;
    if (!landing || landing.toLowerCase() !== rec.email.toLowerCase()) {
      mismatches.push({ kind: "identity", current: landing, recommended: rec.email });
    }
  }
  return mismatches;
}

export type SwitchPlan =
  /** Already signed in (acceptably) on the recommended server — repoint, no OAuth. */
  | { type: "use-server"; baseUrl: string; label: string }
  /** Sign in on the recommended server, as the test identity when hinted. */
  | { type: "sign-in"; baseUrl: string; label: string; loginHint: string | null };

/** The single tap that brings the phone in line with the bundle, or null when
 * nothing differs (or there's nothing actionable to differ from). */
export function recommendationSwitchPlan(
  phone: PhoneState,
  rec: Recommendation,
): SwitchPlan | null {
  const mismatches = recommendationMismatches(phone, rec);
  if (!rec.server || !mismatches.length) return null;
  const { baseUrl, label } = rec.server;
  if (mismatches.some((m) => m.kind === "identity")) {
    return { type: "sign-in", baseUrl, label, loginHint: rec.email };
  }
  // Backend is the only difference. A sign-in already parked on the
  // recommended server makes this a pure repoint; otherwise OAuth it is.
  return phone.recommendedServerEmail
    ? { type: "use-server", baseUrl, label }
    : { type: "sign-in", baseUrl, label, loginHint: rec.email };
}
